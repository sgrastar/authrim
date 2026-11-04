/**
 * Digests for step-up parameters: a secret (a webhook URL, a signing secret) is bound into the
 * receipt by its SHA-256 hex digest, never by its value.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
