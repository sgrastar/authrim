/**
 * Google Provider Configuration
 * Pre-configured settings for Google OIDC authentication
 */

import type { UpstreamProvider } from '../types';

export const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * Default configuration for Google provider
 * Use this as a template when creating a new Google provider via Admin API
 */
export const GOOGLE_DEFAULT_CONFIG: Partial<UpstreamProvider> = {
  name: 'Google',
  providerType: 'oidc',
  issuer: GOOGLE_ISSUER,
  scopes: 'openid email profile',
  attributeMapping: {
    sub: 'sub',
    email: 'email',
    email_verified: 'email_verified',
    name: 'name',
    given_name: 'given_name',
    family_name: 'family_name',
    picture: 'picture',
    locale: 'locale',
  },
  autoLinkEmail: true,
  jitProvisioning: true,
  requireEmailVerified: true,
  iconUrl: 'https://www.google.com/favicon.ico',
  buttonColor: '#4285F4',
  buttonText: 'Continue with Google',
  providerQuirks: {},
};

/**
 * Google-specific claim mappings
 * Google follows OIDC standard closely, so most claims map 1:1
 */
export const GOOGLE_CLAIM_MAPPINGS = {
  // Standard OIDC claims (already standard)
  sub: 'sub',
  email: 'email',
  email_verified: 'email_verified',
  name: 'name',
  given_name: 'given_name',
  family_name: 'family_name',
  picture: 'picture',
  locale: 'locale',

  // Google-specific (if needed)
  hd: 'hd', // Hosted domain (Google Workspace)
};

/**
 * Validate Google-specific requirements
 */
export function validateGoogleConfig(provider: Partial<UpstreamProvider>): string[] {
  const errors: string[] = [];

  if (!provider.clientId) {
    errors.push('clientId is required');
  }

  if (!provider.clientSecretEncrypted) {
    errors.push('clientSecret is required');
  }

  // Google requires specific scopes
  const scopes = provider.scopes?.split(/[\s,]+/) || [];
  if (!scopes.includes('openid')) {
    errors.push('openid scope is required for OIDC');
  }

  return errors;
}
