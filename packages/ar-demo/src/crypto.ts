const TENANT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlText(text: string): string {
  return base64Url(encoder.encode(text));
}

/** `demo-` and ten characters of the base32 alphabet. 256 is a multiple of 32, so `& 31` is unbiased. */
export function newTenantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let suffix = '';
  for (const byte of bytes) suffix += TENANT_ALPHABET[byte & 31];
  return `demo-${suffix}`;
}

/** 32 random bytes, base64url (43 characters). */
export function newTicket(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}
