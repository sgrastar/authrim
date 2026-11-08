/**
 * Facebook `signed_request` verification
 *
 * Meta posts a `signed_request` to an app's Data Deletion Request Callback and Deauthorize
 * Callback: `<signature>.<payload>`, each base64url, the signature the HMAC-SHA256 of the encoded
 * payload under the app secret, the payload JSON with `algorithm`, `issued_at` and `user_id` (the
 * app-scoped id of the person).
 *
 * The signature is checked before anything in the payload is trusted, with a constant-time
 * comparison (WebCrypto `verify`). Only HMAC-SHA256 is accepted, and the request must have been
 * issued within the allowed age (a little clock skew is tolerated for one issued "in the future").
 *
 * @see https://developers.facebook.com/docs/facebook-login/guides/advanced/existing-system#parsingsr
 * @see https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */

/** A signed_request longer than this is refused unread (Meta's are a few hundred bytes). */
export const FACEBOOK_SIGNED_REQUEST_MAX_LENGTH = 4096;

/** How far in the future `issued_at` may be (clock skew between Meta and this server). */
export const FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS = 60;

export type FacebookSignedRequestError =
  | 'malformed'
  | 'bad_signature'
  | 'unsupported_algorithm'
  /** A signed request of the login flow (it carries a code or a token), not a callback's. */
  | 'wrong_purpose'
  | 'stale'
  | 'invalid_user_id';

export type FacebookSignedRequestResult =
  | { ok: true; userId: string; issuedAt: number }
  | { ok: false; error: FacebookSignedRequestError };

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/u;
/** App-scoped user ids are decimal strings. */
const FACEBOOK_USER_ID = /^[0-9]{1,64}$/u;
const HMAC_SHA256_SIGNATURE_BYTES = 32;

function base64UrlDecode(value: string): Uint8Array | null {
  if (!BASE64URL.test(value)) return null;
  const unpadded = value.replace(/=+$/u, '');
  // A base64 string of one character more than a multiple of four encodes no whole byte.
  if (unpadded.length % 4 === 1) return null;
  const base64 = unpadded.replace(/-/gu, '+').replace(/_/gu, '/');
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Verify a Facebook signed_request with the app secret.
 *
 * @param signedRequest - the `signed_request` form field as posted
 * @param appSecret - the app secret (the provider configuration's client secret)
 * @param options.nowSeconds - the current time (epoch seconds)
 * @param options.maxAgeSeconds - how long after `issued_at` the request is still accepted
 */
export async function verifyFacebookSignedRequest(
  signedRequest: string,
  appSecret: string,
  options: { nowSeconds: number; maxAgeSeconds: number }
): Promise<FacebookSignedRequestResult> {
  if (
    typeof signedRequest !== 'string' ||
    signedRequest.length === 0 ||
    signedRequest.length > FACEBOOK_SIGNED_REQUEST_MAX_LENGTH ||
    typeof appSecret !== 'string' ||
    appSecret.length === 0
  ) {
    return { ok: false, error: 'malformed' };
  }
  const parts = signedRequest.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'malformed' };
  const [encodedSignature, encodedPayload] = parts as [string, string];

  const signature = base64UrlDecode(encodedSignature);
  if (!signature || signature.length !== HMAC_SHA256_SIGNATURE_BYTES) {
    return { ok: false, error: 'malformed' };
  }
  const payloadBytes = base64UrlDecode(encodedPayload);
  if (!payloadBytes) return { ok: false, error: 'malformed' };

  // The HMAC is over the payload as encoded (not its decoded bytes), as Meta signs it.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(encodedPayload));
  if (!valid) return { ok: false, error: 'bad_signature' };

  // Only now is the payload trusted.
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'malformed' };
  }
  const claims = payload as Record<string, unknown>;
  if (typeof claims.algorithm !== 'string' || claims.algorithm.toUpperCase() !== 'HMAC-SHA256') {
    return { ok: false, error: 'unsupported_algorithm' };
  }
  // The JavaScript SDK's and other login-flow signed requests are signed with the same secret;
  // they carry an authorization code or a token, the callbacks' never do.
  if ('code' in claims || 'oauth_token' in claims) return { ok: false, error: 'wrong_purpose' };
  const issuedAt = claims.issued_at;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    return { ok: false, error: 'stale' };
  }
  if (
    issuedAt > options.nowSeconds + FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS ||
    options.nowSeconds - issuedAt > options.maxAgeSeconds
  ) {
    return { ok: false, error: 'stale' };
  }
  const userId =
    typeof claims.user_id === 'string'
      ? claims.user_id
      : typeof claims.user_id === 'number' && Number.isSafeInteger(claims.user_id)
        ? String(claims.user_id)
        : undefined;
  if (!userId || !FACEBOOK_USER_ID.test(userId)) return { ok: false, error: 'invalid_user_id' };
  return { ok: true, userId, issuedAt };
}
