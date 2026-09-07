/**
 * Facebook Provider Configuration
 * Pre-configured settings for Facebook Login (OAuth 2.0)
 *
 * Facebook uses OAuth 2.0 (not OIDC), so it requires:
 * - Explicit endpoint configuration (no OIDC discovery)
 * - UserInfo fetch via Graph API
 * - Attribute mapping for non-standard claims (id → sub)
 * - app_secret_proof for enhanced security
 *
 * Scopes:
 * - email: Access to user's primary email
 * - public_profile: Basic profile info (name, picture)
 *
 * GDPR Compliance:
 * - Data Deletion Callback: Facebook requires apps to implement a callback URL
 *   that receives signed requests when users request data deletion.
 *   Configure in: App Dashboard → Settings → Basic → User Data Deletion
 * - Permission Revocation: Use DELETE /me/permissions to revoke all permissions,
 *   or DELETE /me/permissions/{permission} to revoke specific ones.
 *
 * References:
 * - https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 * - https://developers.facebook.com/docs/graph-api/reference/user
 * - https://developers.facebook.com/docs/graph-api/securing-requests
 * - https://developers.facebook.com/docs/facebook-login/guides/permissions/request-revoke
 * - https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */

import type { UpstreamProvider } from '../types';

// =============================================================================
// Facebook Constants
// =============================================================================

export const FACEBOOK_API_VERSION = 'v20.0';
export const FACEBOOK_AUTHORIZATION_ENDPOINT = `https://www.facebook.com/${FACEBOOK_API_VERSION}/dialog/oauth`;
export const FACEBOOK_TOKEN_ENDPOINT = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/oauth/access_token`;
export const FACEBOOK_USERINFO_ENDPOINT = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/me`;
// Permission revocation endpoint - DELETE /me/permissions or DELETE /{user-id}/permissions
export const FACEBOOK_REVOCATION_ENDPOINT = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/me/permissions`;

// =============================================================================
// Facebook-Specific Quirks
// =============================================================================

/**
 * Facebook provider quirks configuration
 */
export interface FacebookProviderQuirks {
  /**
   * Graph API version (e.g., "v20.0")
   * Default: v20.0
   */
  apiVersion?: string;

  /**
   * Use app_secret_proof for enhanced security
   * Recommended: true (Facebook may require this for apps with "Require App Secret" enabled)
   * Default: true
   *
   * @see https://developers.facebook.com/docs/graph-api/securing-requests
   */
  useAppSecretProof?: boolean;

  /**
   * Fields to request from the /me endpoint
   * Default: ['id', 'name', 'email', 'picture.type(large)']
   */
  fields?: string[];
}

// =============================================================================
// Facebook Default Configuration
// =============================================================================

/**
 * Default configuration for Facebook provider
 * Use this as a template when creating a new Facebook provider via Admin API
 */
export const FACEBOOK_DEFAULT_CONFIG: Partial<UpstreamProvider> = {
  name: 'Facebook',
  providerType: 'oauth2', // Facebook is OAuth 2.0, not OIDC
  // No issuer for OAuth 2.0 providers
  issuer: undefined,
  authorizationEndpoint: FACEBOOK_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: FACEBOOK_TOKEN_ENDPOINT,
  userinfoEndpoint: FACEBOOK_USERINFO_ENDPOINT,
  // Facebook doesn't have JWKS (no ID tokens)
  jwksUri: undefined,
  // Default scopes for user profile and email
  scopes: 'email public_profile',
  // Attribute mapping: Facebook claims → OIDC standard claims
  attributeMapping: {
    sub: 'id', // Facebook uses string `id` instead of `sub`
    email: 'email',
    name: 'name',
    // Facebook returns picture as nested object: picture.data.url
    picture: 'picture.data.url',
    // Facebook doesn't provide these directly, but we map them for consistency
    given_name: 'first_name',
    family_name: 'last_name',
  },
  // Facebook does not provide an email_verified claim. Keep automatic email linking disabled so
  // future claim-mapping changes cannot silently turn an unverified address into link authority.
  autoLinkEmail: false,
  jitProvisioning: true,
  // Facebook doesn't return email_verified, so we can't require it
  requireEmailVerified: false,
  iconUrl: 'https://www.facebook.com/favicon.ico',
  buttonColor: '#1877F2',
  buttonText: 'Continue with Facebook',
  providerQuirks: {
    apiVersion: 'v20.0',
    useAppSecretProof: true,
    fields: ['id', 'name', 'email', 'first_name', 'last_name', 'picture.type(large)'],
  } as Record<string, unknown>,
};

// =============================================================================
// Facebook Claim Mappings
// =============================================================================

/**
 * Facebook Graph API /me response fields
 * Mapped to OIDC standard claims where applicable
 */
export const FACEBOOK_CLAIM_MAPPINGS = {
  // Core identification
  sub: 'id', // Facebook user ID (unique, string)

  // Profile information
  name: 'name', // Full name
  given_name: 'first_name', // First name
  family_name: 'last_name', // Last name
  email: 'email', // Primary email
  picture: 'picture.data.url', // Profile picture URL (nested)

  // Additional Facebook-specific claims
  birthday: 'birthday', // Birthday (requires user_birthday permission)
  gender: 'gender', // Gender
  link: 'link', // Profile URL
  locale: 'locale', // Locale
  timezone: 'timezone', // Timezone offset
  verified: 'verified', // Facebook account verified
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Build Facebook endpoints with custom API version
 *
 * @param apiVersion - Graph API version (e.g., "v20.0")
 */
export function getFacebookEndpoints(apiVersion: string = FACEBOOK_API_VERSION): {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
} {
  return {
    authorizationEndpoint: `https://www.facebook.com/${apiVersion}/dialog/oauth`,
    tokenEndpoint: `https://graph.facebook.com/${apiVersion}/oauth/access_token`,
    userinfoEndpoint: `https://graph.facebook.com/${apiVersion}/me`,
  };
}

/**
 * Get effective endpoints for a Facebook provider
 * Returns endpoints with the API version from quirks, otherwise default
 */
export function getFacebookEffectiveEndpoints(quirks?: FacebookProviderQuirks): {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
} {
  const apiVersion = quirks?.apiVersion || FACEBOOK_API_VERSION;
  return getFacebookEndpoints(apiVersion);
}

/**
 * Generate app_secret_proof for Facebook Graph API requests
 *
 * The proof is HMAC-SHA256(access_token, app_secret) encoded as hex.
 * This provides additional security by proving the request comes from
 * someone who knows the app secret.
 *
 * @param accessToken - The user's access token
 * @param appSecret - The Facebook app secret
 * @returns Hex-encoded HMAC-SHA256 hash
 *
 * @see https://developers.facebook.com/docs/graph-api/securing-requests
 */
export async function generateAppSecretProof(
  accessToken: string,
  appSecret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(accessToken));

  // Convert to hex string
  const hashArray = new Uint8Array(signature);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate Facebook-specific requirements
 */
export function validateFacebookConfig(provider: Partial<UpstreamProvider>): string[] {
  const errors: string[] = [];

  if (!provider.clientId) {
    errors.push('clientId (App ID) is required');
  }

  if (!provider.clientSecretEncrypted) {
    errors.push('clientSecret (App Secret) is required');
  }

  // Validate scopes
  const scopes = provider.scopes?.split(/[\s,]+/) || [];
  if (!scopes.includes('public_profile') && scopes.length === 0) {
    errors.push('At least one scope is required (e.g., public_profile)');
  }

  // Validate API version format if provided
  const quirks = provider.providerQuirks as FacebookProviderQuirks | undefined;
  if (quirks?.apiVersion && !/^v\d+\.\d+$/.test(quirks.apiVersion)) {
    errors.push('apiVersion must be in format "vX.Y" (e.g., "v20.0")');
  }

  return errors;
}

/**
 * Create Facebook provider config with custom options
 */
export function createFacebookConfig(options?: {
  apiVersion?: string;
  overrides?: Partial<UpstreamProvider>;
}): Partial<UpstreamProvider> {
  const config = { ...FACEBOOK_DEFAULT_CONFIG };

  if (options?.apiVersion) {
    const endpoints = getFacebookEndpoints(options.apiVersion);
    config.authorizationEndpoint = endpoints.authorizationEndpoint;
    config.tokenEndpoint = endpoints.tokenEndpoint;
    config.userinfoEndpoint = endpoints.userinfoEndpoint;
    config.providerQuirks = {
      ...(config.providerQuirks as FacebookProviderQuirks),
      apiVersion: options.apiVersion,
    };
  }

  if (options?.overrides) {
    return { ...config, ...options.overrides };
  }

  return config;
}
