/**
 * GitHub Provider Configuration
 * Pre-configured settings for GitHub OAuth 2.0 authentication
 *
 * GitHub uses OAuth 2.0 (not OIDC), so it requires:
 * - Explicit endpoint configuration (no OIDC discovery)
 * - UserInfo fetch via GitHub API
 * - Attribute mapping for non-standard claims (id → sub, avatar_url → picture)
 *
 * Scopes:
 * - read:user: Read user profile data
 * - user:email: Read user email addresses (including private emails)
 *
 * References:
 * - https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 * - https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28#get-the-authenticated-user
 */

import type { UpstreamProvider } from '../types';

// =============================================================================
// GitHub Constants
// =============================================================================

export const GITHUB_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
export const GITHUB_USERINFO_ENDPOINT = 'https://api.github.com/user';
export const GITHUB_USER_EMAILS_ENDPOINT = 'https://api.github.com/user/emails';

// =============================================================================
// GitHub-Specific Quirks
// =============================================================================

/**
 * GitHub provider quirks configuration
 */
export interface GitHubProviderQuirks {
  /**
   * Allow GitHub Enterprise Server (GHES) URLs
   * If true, you can override the authorization/token/userinfo endpoints
   * for GitHub Enterprise installations
   */
  allowEnterpriseServer?: boolean;

  /**
   * GitHub Enterprise Server base URL
   * e.g., "https://github.mycompany.com"
   * Only used if allowEnterpriseServer is true
   */
  enterpriseServerUrl?: string;

  /**
   * Fetch primary verified email from /user/emails endpoint
   * Recommended: true (GitHub's /user endpoint may not return email)
   * Default: true
   */
  fetchPrimaryEmail?: boolean;

  /**
   * Allow unverified emails from GitHub
   * Security: Should be false for most use cases
   * Default: false
   */
  allowUnverifiedEmail?: boolean;
}

// =============================================================================
// GitHub Default Configuration
// =============================================================================

/**
 * Default configuration for GitHub provider
 * Use this as a template when creating a new GitHub provider via Admin API
 */
export const GITHUB_DEFAULT_CONFIG: Partial<UpstreamProvider> = {
  name: 'GitHub',
  providerType: 'oauth2', // GitHub is OAuth 2.0, not OIDC
  // No issuer for OAuth 2.0 providers - we use explicit endpoints
  issuer: undefined,
  authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
  userinfoEndpoint: GITHUB_USERINFO_ENDPOINT,
  // GitHub doesn't have JWKS (no ID tokens)
  jwksUri: undefined,
  // Default scopes for user profile and email
  scopes: 'read:user user:email',
  // Attribute mapping: GitHub claims → OIDC standard claims
  attributeMapping: {
    sub: 'id', // GitHub uses numeric `id` instead of `sub`
    email: 'email',
    email_verified: 'email_verified', // We'll set this from /user/emails API
    name: 'name',
    preferred_username: 'login', // GitHub username
    picture: 'avatar_url',
    profile: 'html_url', // GitHub profile URL
  },
  autoLinkEmail: true,
  jitProvisioning: true,
  requireEmailVerified: true,
  iconUrl: 'https://github.githubassets.com/favicons/favicon.svg',
  buttonColor: '#24292f',
  buttonText: 'Continue with GitHub',
  providerQuirks: {
    fetchPrimaryEmail: true,
    allowUnverifiedEmail: false,
  } as Record<string, unknown>,
};

// =============================================================================
// GitHub Claim Mappings
// =============================================================================

/**
 * GitHub API /user response fields
 * Mapped to OIDC standard claims where applicable
 */
export const GITHUB_CLAIM_MAPPINGS = {
  // Core identification
  sub: 'id', // Numeric user ID (unique, immutable)
  preferred_username: 'login', // GitHub username (@handle)

  // Profile information
  name: 'name', // Display name (can be null)
  email: 'email', // Primary email (can be null if private)
  picture: 'avatar_url', // Avatar URL
  profile: 'html_url', // GitHub profile URL

  // Additional GitHub-specific claims
  company: 'company',
  blog: 'blog',
  location: 'location',
  bio: 'bio',
  twitter_username: 'twitter_username',
  public_repos: 'public_repos',
  followers: 'followers',
  following: 'following',
  created_at: 'created_at', // Account creation date
  updated_at: 'updated_at',

  // GitHub Enterprise/Organization info
  site_admin: 'site_admin', // Is GitHub staff
};

/**
 * GitHub /user/emails response structure
 */
export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null; // 'public' | 'private' | null
}

// =============================================================================
// GitHub Enterprise Support
// =============================================================================

/**
 * Build GitHub endpoints for GitHub Enterprise Server
 *
 * @param enterpriseUrl - Base URL of GitHub Enterprise Server (e.g., "https://github.mycompany.com")
 */
export function getGitHubEnterpriseEndpoints(enterpriseUrl: string): {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  userEmailsEndpoint: string;
} {
  // Remove trailing slash
  const baseUrl = enterpriseUrl.replace(/\/$/, '');

  return {
    authorizationEndpoint: `${baseUrl}/login/oauth/authorize`,
    tokenEndpoint: `${baseUrl}/login/oauth/access_token`,
    userinfoEndpoint: `${baseUrl}/api/v3/user`,
    userEmailsEndpoint: `${baseUrl}/api/v3/user/emails`,
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate GitHub-specific requirements
 */
export function validateGitHubConfig(provider: Partial<UpstreamProvider>): string[] {
  const errors: string[] = [];

  if (!provider.clientId) {
    errors.push('clientId is required');
  }

  if (!provider.clientSecretEncrypted) {
    errors.push('clientSecret is required');
  }

  // Validate scopes
  const scopes = provider.scopes?.split(/[\s,]+/) || [];
  if (!scopes.includes('read:user') && !scopes.includes('user')) {
    errors.push('read:user or user scope is required to fetch user profile');
  }

  // Validate enterprise configuration
  const quirks = provider.providerQuirks as GitHubProviderQuirks | undefined;
  if (quirks?.allowEnterpriseServer) {
    if (!quirks.enterpriseServerUrl) {
      errors.push('enterpriseServerUrl is required when allowEnterpriseServer is true');
    } else {
      // Validate URL format
      try {
        new URL(quirks.enterpriseServerUrl);
      } catch {
        errors.push('enterpriseServerUrl must be a valid URL');
      }
    }
  }

  return errors;
}

/**
 * Get effective endpoints for a GitHub provider
 * Returns enterprise endpoints if configured, otherwise default GitHub.com endpoints
 */
export function getGitHubEffectiveEndpoints(provider: Partial<UpstreamProvider>): {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  userEmailsEndpoint: string;
} {
  const quirks = provider.providerQuirks as GitHubProviderQuirks | undefined;

  if (quirks?.allowEnterpriseServer && quirks.enterpriseServerUrl) {
    return getGitHubEnterpriseEndpoints(quirks.enterpriseServerUrl);
  }

  return {
    authorizationEndpoint: provider.authorizationEndpoint || GITHUB_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: provider.tokenEndpoint || GITHUB_TOKEN_ENDPOINT,
    userinfoEndpoint: provider.userinfoEndpoint || GITHUB_USERINFO_ENDPOINT,
    userEmailsEndpoint: GITHUB_USER_EMAILS_ENDPOINT,
  };
}

/**
 * Create GitHub provider config with optional Enterprise Server support
 */
export function createGitHubConfig(options?: {
  enterpriseServerUrl?: string;
  overrides?: Partial<UpstreamProvider>;
}): Partial<UpstreamProvider> {
  const config = { ...GITHUB_DEFAULT_CONFIG };

  if (options?.enterpriseServerUrl) {
    const endpoints = getGitHubEnterpriseEndpoints(options.enterpriseServerUrl);
    config.authorizationEndpoint = endpoints.authorizationEndpoint;
    config.tokenEndpoint = endpoints.tokenEndpoint;
    config.userinfoEndpoint = endpoints.userinfoEndpoint;
    config.providerQuirks = {
      ...(config.providerQuirks as GitHubProviderQuirks),
      allowEnterpriseServer: true,
      enterpriseServerUrl: options.enterpriseServerUrl,
    };
  }

  if (options?.overrides) {
    return { ...config, ...options.overrides };
  }

  return config;
}
