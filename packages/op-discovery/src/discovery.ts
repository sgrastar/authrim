import type { Context } from 'hono';
import type { Env, OIDCProviderMetadata } from '@authrim/shared';
import { SUPPORTED_JWE_ALG, SUPPORTED_JWE_ENC } from '@authrim/shared';

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
    // RFC 8628: Device Authorization endpoint
    device_authorization_endpoint: `${issuer}/device_authorization`,
    // OIDC CIBA: Backchannel Authentication endpoint
    backchannel_authentication_endpoint: `${issuer}/bc-authorize`,
    backchannel_token_delivery_modes_supported: ['poll', 'ping', 'push'],
    backchannel_authentication_request_signing_alg_values_supported: ['RS256', 'ES256'],
    backchannel_user_code_parameter_supported: true,
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'form_post'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer', // RFC 7523: JWT Bearer Flow
      'urn:ietf:params:oauth:grant-type:device_code', // RFC 8628: Device Authorization Grant
      'urn:openid:params:grant-type:ciba', // OIDC CIBA: Client Initiated Backchannel Authentication
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
    request_object_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    request_object_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    // JARM (JWT-Secured Authorization Response Mode) support
    response_modes_supported: [
      'query',
      'fragment',
      'form_post',
      'query.jwt',
      'fragment.jwt',
      'form_post.jwt',
      'jwt',
    ],
    authorization_signing_alg_values_supported: ['RS256'],
    authorization_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    authorization_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
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
