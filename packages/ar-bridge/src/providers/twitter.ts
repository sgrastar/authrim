/**
 * Twitter/X Provider Configuration
 * Pre-configured settings for Twitter/X OAuth 2.0 authentication
 *
 * Twitter uses OAuth 2.0 with PKCE (not OIDC), so it requires:
 * - PKCE with S256 challenge method (mandatory)
 * - Basic authentication for token exchange
 * - UserInfo fetch via API v2 /users/me endpoint
 * - Attribute mapping for nested response (data.id, data.name, etc.)
 *
 * Scopes:
 * - users.read: Read user profile data
 * - tweet.read: Required for OAuth 2.0 (minimum scope)
 * - offline.access: Get refresh token for long-lived access
 *
 * Note: Email access requires elevated API access and app review.
 *
 * References:
 * - https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code
 * - https://developer.twitter.com/en/docs/twitter-api/users/lookup/api-reference/get-users-me
 */

import type { UpstreamProvider } from '../types';
import { createLogger } from '@authrim/ar-lib-core';

const log = createLogger().module('TWITTER');

// =============================================================================
// Twitter Constants
// =============================================================================

export const TWITTER_AUTHORIZATION_ENDPOINT = 'https://twitter.com/i/oauth2/authorize';
export const TWITTER_TOKEN_ENDPOINT = 'https://api.twitter.com/2/oauth2/token';
export const TWITTER_USERINFO_ENDPOINT = 'https://api.twitter.com/2/users/me';
export const TWITTER_REVOCATION_ENDPOINT = 'https://api.twitter.com/2/oauth2/revoke';

// =============================================================================
// Twitter-Specific Quirks
// =============================================================================

/**
 * Twitter provider quirks configuration
 */
export interface TwitterProviderQuirks {
  /**
   * Use Basic authentication for token exchange
   * Twitter requires client_id:client_secret as Base64-encoded Basic auth header
   * Default: true
   */
  useBasicAuth?: boolean;

  /**
   * PKCE is required for Twitter OAuth 2.0
   * This is informational only - PKCE is always enforced
   * Default: true
   */
  pkceRequired?: boolean;

  /**
   * User fields to request from /users/me endpoint
   * Default: 'id,name,username,profile_image_url'
   *
   * @see https://developer.twitter.com/en/docs/twitter-api/data-dictionary/object-model/user
   */
  userFields?: string;

  /**
   * Include email in user fields (requires elevated access)
   * Requires App review and "Request email from users" permission
   * Default: false
   */
  includeEmail?: boolean;

  /**
   * Expansions to include in user response
   * e.g., 'pinned_tweet_id'
   */
  expansions?: string;
}

// =============================================================================
// Twitter Default Configuration
// =============================================================================

/**
 * Default configuration for Twitter provider
 * Use this as a template when creating a new Twitter provider via Admin API
 */
export const TWITTER_DEFAULT_CONFIG: Partial<UpstreamProvider> = {
  name: 'Twitter',
  providerType: 'oauth2', // Twitter is OAuth 2.0, not OIDC
  // No issuer for OAuth 2.0 providers
  issuer: undefined,
  authorizationEndpoint: TWITTER_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: TWITTER_TOKEN_ENDPOINT,
  userinfoEndpoint: TWITTER_USERINFO_ENDPOINT,
  // Twitter doesn't have JWKS (no ID tokens)
  jwksUri: undefined,
  // Default scopes - offline.access for refresh tokens
  scopes: 'users.read tweet.read offline.access',
  // Attribute mapping: Twitter API v2 returns nested data
  attributeMapping: {
    sub: 'data.id', // Twitter user ID (unique, string)
    name: 'data.name', // Display name
    preferred_username: 'data.username', // @handle
    picture: 'data.profile_image_url', // Avatar URL
  },
  // Twitter requires app review for email access, so we can't auto-link by default
  autoLinkEmail: false,
  jitProvisioning: true,
  // Email requires elevated access, so we can't require verification
  requireEmailVerified: false,
  iconUrl: 'https://abs.twimg.com/favicons/twitter.3.ico',
  buttonColor: '#000000',
  buttonText: 'Continue with X',
  providerQuirks: {
    useBasicAuth: true,
    pkceRequired: true,
    userFields: 'id,name,username,profile_image_url',
    includeEmail: false,
  } as Record<string, unknown>,
};

// =============================================================================
// Twitter Claim Mappings
// =============================================================================

/**
 * Twitter API v2 /users/me response fields
 * Response is wrapped in "data" object
 * Mapped to OIDC standard claims where applicable
 */
export const TWITTER_CLAIM_MAPPINGS = {
  // Core identification (all under data.*)
  sub: 'data.id', // Twitter user ID (string, unique)
  preferred_username: 'data.username', // @handle
  name: 'data.name', // Display name
  picture: 'data.profile_image_url', // Avatar URL

  // Additional fields (require user.fields parameter)
  email: 'data.email', // Requires elevated access
  profile: 'data.url', // Profile URL
  description: 'data.description', // Bio
  location: 'data.location', // Location
  verified: 'data.verified', // Blue check (legacy)
  verified_type: 'data.verified_type', // New verification type
  created_at: 'data.created_at', // Account creation date
  protected: 'data.protected', // Protected tweets
  public_metrics: 'data.public_metrics', // Follower counts, etc.
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Build userinfo URL with fields and expansions
 */
export function getTwitterUserInfoUrl(quirks?: TwitterProviderQuirks): string {
  const url = new URL(TWITTER_USERINFO_ENDPOINT);

  // Add user fields
  let userFields = quirks?.userFields || 'id,name,username,profile_image_url';

  // Add email if requested (requires elevated access)
  if (quirks?.includeEmail) {
    // Twitter doesn't actually return email in user.fields
    // Email requires additional API access
    log.warn('Twitter email access requires elevated API permissions');
  }

  url.searchParams.set('user.fields', userFields);

  // Add expansions if specified
  if (quirks?.expansions) {
    url.searchParams.set('expansions', quirks.expansions);
  }

  return url.toString();
}

/**
 * Get effective endpoints for a Twitter provider
 */
export function getTwitterEffectiveEndpoints(quirks?: TwitterProviderQuirks): {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
} {
  return {
    authorizationEndpoint: TWITTER_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: TWITTER_TOKEN_ENDPOINT,
    userinfoEndpoint: getTwitterUserInfoUrl(quirks),
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate Twitter-specific requirements
 */
export function validateTwitterConfig(provider: Partial<UpstreamProvider>): string[] {
  const errors: string[] = [];

  if (!provider.clientId) {
    errors.push('clientId (OAuth 2.0 Client ID) is required');
  }

  if (!provider.clientSecretEncrypted) {
    errors.push('clientSecret (OAuth 2.0 Client Secret) is required');
  }

  // Validate scopes
  const scopes = provider.scopes?.split(/[\s,]+/) || [];

  // Check for required scopes
  if (!scopes.includes('users.read')) {
    errors.push('users.read scope is required to fetch user profile');
  }

  // Note: tweet.read is technically required but some apps may not need it
  // We just warn if missing
  if (!scopes.includes('tweet.read')) {
    log.warn('Twitter: tweet.read scope is typically required for OAuth 2.0');
  }

  // Validate user.fields format if provided
  const quirks = provider.providerQuirks as TwitterProviderQuirks | undefined;
  if (quirks?.userFields) {
    const validFields = [
      'id',
      'name',
      'username',
      'profile_image_url',
      'description',
      'url',
      'location',
      'verified',
      'verified_type',
      'created_at',
      'protected',
      'public_metrics',
      'withheld',
      'pinned_tweet_id',
    ];

    const requestedFields = quirks.userFields.split(',').map((f) => f.trim());
    const invalidFields = requestedFields.filter((f) => !validFields.includes(f));

    if (invalidFields.length > 0) {
      errors.push(`Invalid user.fields: ${invalidFields.join(', ')}`);
    }
  }

  return errors;
}

/**
 * Create Twitter provider config with custom options
 */
export function createTwitterConfig(options?: {
  includeEmail?: boolean;
  userFields?: string;
  overrides?: Partial<UpstreamProvider>;
}): Partial<UpstreamProvider> {
  const config = { ...TWITTER_DEFAULT_CONFIG };

  if (options?.includeEmail || options?.userFields) {
    const quirks: TwitterProviderQuirks = {
      ...(config.providerQuirks as TwitterProviderQuirks),
    };

    if (options.includeEmail) {
      quirks.includeEmail = true;
    }

    if (options.userFields) {
      quirks.userFields = options.userFields;
    }

    config.providerQuirks = quirks as unknown as Record<string, unknown>;
    config.userinfoEndpoint = getTwitterUserInfoUrl(quirks);
  }

  if (options?.overrides) {
    return { ...config, ...options.overrides };
  }

  return config;
}
