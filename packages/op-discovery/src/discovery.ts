import type { Context } from 'hono';
import type { Env, OIDCProviderMetadata } from '@enrai/shared';
import { SUPPORTED_JWE_ALG, SUPPORTED_JWE_ENC } from '@enrai/shared';

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
    // RFC 7662: Token Introspection endpoint
    introspection_endpoint: `${issuer}/introspect`,
    // RFC 7009: Token Revocation endpoint
    revocation_endpoint: `${issuer}/revoke`,
    // RFC 9126: PAR endpoint
    pushed_authorization_request_endpoint: `${issuer}/as/par`,
    // RFC 9126: PAR is optional (not required)
    require_pushed_authorization_requests: false,
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'form_post'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer', // RFC 7523: JWT Bearer Flow
    ],
    id_token_signing_alg_values_supported: ['RS256'],
    // OIDC Core 8: Both public and pairwise subject identifiers are supported
    subject_types_supported: ['public', 'pairwise'],
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
      'auth_time', // OIDC Core: Authentication timestamp
      'acr', // OIDC Core: Authentication Context Class Reference
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
    // RFC 9449: DPoP (Demonstrating Proof of Possession) support
    dpop_signing_alg_values_supported: ['RS256', 'ES256'],
    // RFC 9101 (JAR): Request Object support
    request_parameter_supported: true,
    request_uri_parameter_supported: true,
    request_object_signing_alg_values_supported: ['RS256', 'none'],
    // RFC 7516: JWE (JSON Web Encryption) support
    id_token_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    id_token_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    userinfo_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    userinfo_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    // OIDC Core: Additional metadata
    claim_types_supported: ['normal'],
    claims_parameter_supported: true,
    // ACR (Authentication Context Class Reference) support
    acr_values_supported: ['urn:mace:incommon:iap:silver', 'urn:mace:incommon:iap:bronze'],
  };

  // Add cache headers for better performance
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('Vary', 'Accept-Encoding');

  return c.json(metadata);
}
