import { createHmac } from 'node:crypto';

/** base64url (no padding) of a string's UTF-8 bytes. */
export function b64url(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url of HMAC-SHA256(value) under the secret. */
export function hmacB64url(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** A signed_request as Meta builds it: HMAC-SHA256 of the encoded payload under the secret. */
export function signFacebookRequest(
  payload: Record<string, unknown>,
  secret: string,
  options: { pad?: boolean } = {}
): string {
  const encodedPayload = b64url(JSON.stringify(payload));
  const encodedSignature = options.pad
    ? createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
    : hmacB64url(encodedPayload, secret);
  return `${encodedSignature}.${encodedPayload}`;
}
