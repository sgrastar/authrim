/**
 * OAuth 2.0 / OpenID4VCI error responses for the issuer endpoints.
 *
 * Wallets act on these standard codes, so the issuer endpoints do not use Authrim AR codes.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-5.2
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#section-8.3.1.2
 */

import type { Context } from 'hono';

export type VciTokenErrorCode =
  | 'invalid_request'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_authorization_details'
  | 'unauthorized_client'
  | 'temporarily_unavailable'
  | 'server_error';

export type VciCredentialErrorCode =
  | 'invalid_credential_request'
  | 'unknown_credential_configuration'
  | 'invalid_proof'
  | 'invalid_nonce'
  | 'server_error';

type ErrorStatus = 400 | 401 | 424 | 500 | 503;

function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

export function vciError(
  c: Context,
  status: ErrorStatus,
  error: VciTokenErrorCode | VciCredentialErrorCode,
  description?: string
): Response {
  noStore(c);
  return c.json(description ? { error, error_description: description } : { error }, status);
}

/** RFC 9449 §7.1: a DPoP-bound access token or its proof is unusable at the Credential Endpoint. */
export function invalidDpopTokenError(
  c: Context,
  error: 'invalid_token' | 'invalid_dpop_proof'
): Response {
  noStore(c);
  c.header('WWW-Authenticate', `DPoP error="${error}", algs="ES256"`);
  return c.json({ error }, 401);
}

/** RFC 9449 §8: the proof needs the server's nonce; the response carries a fresh one. */
export function useDpopNonceError(c: Context, nonce: string): Response {
  noStore(c);
  c.header('DPoP-Nonce', nonce);
  c.header('WWW-Authenticate', 'DPoP error="use_dpop_nonce", algs="ES256"');
  return c.json({ error: 'use_dpop_nonce' }, 401);
}

/** RFC 6750 §3: a missing or unusable access token at the Credential Endpoint. */
export function invalidTokenError(c: Context): Response {
  noStore(c);
  c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  return c.json({ error: 'invalid_token' }, 401);
}
