import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { OIDCProviderMetadata } from '../types/oidc';

/**
 * OpenID Connect Discovery Endpoint Handler
 * https://openid.net/specs/openid-connect-discovery-1_0.html
 *
 * Returns metadata about the OpenID Provider's configuration
 */
export async function discoveryHandler(c: Context<{ Bindings: Env }>) {
  const issuer = c.env.ISSUER_URL;

  const metadata: OIDCProviderMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    id_token_signing_alg_values_supported: ['RS256'],
    subject_types_supported: ['public'],
    scopes_supported: ['openid', 'profile', 'email', 'address', 'phone'],
    claims_supported: [
      // Standard claims (always present)
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'nonce',
      'at_hash',
      // Profile scope claims (OIDC Core 5.4)
      'name',
      'family_name',
      'given_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
      // Email scope claims
      'email',
      'email_verified',
      // Address scope claims
      'address',
      // Phone scope claims
      'phone_number',
      'phone_number_verified',
    ],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
  };

  // Add cache headers for better performance
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('Vary', 'Accept-Encoding');

  return c.json(metadata);
}
