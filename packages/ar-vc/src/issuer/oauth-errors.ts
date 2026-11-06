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

type ErrorStatus = 400 | 401 | 500 | 503;

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

/** RFC 6750 §3: a missing or unusable access token at the Credential Endpoint. */
export function invalidTokenError(c: Context): Response {
  noStore(c);
  c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  return c.json({ error: 'invalid_token' }, 401);
}
