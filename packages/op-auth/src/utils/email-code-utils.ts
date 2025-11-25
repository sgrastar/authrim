/**
 * Email Code (OTP) Utilities
 * Secure generation and verification of email verification codes
 */

/**
 * Generate a cryptographically secure 6-digit OTP code
 * Uses CSPRNG (crypto.getRandomValues) for secure random number generation
 */
export function generateEmailCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  // Generate 6-digit code (000000-999999)
  const code = (array[0] % 1000000).toString().padStart(6, '0');
  return code;
}

/**
 * Hash an email code using HMAC-SHA256
 * This creates a secure hash that can be stored and verified later
 *
 * @param code - The 6-digit OTP code
 * @param email - The user's email address
 * @param sessionId - The OTP session ID for session binding
 * @param issuedAt - The timestamp when the code was issued
 * @param secret - The HMAC secret key
 */
export async function hashEmailCode(
  code: string,
  email: string,
  sessionId: string,
  issuedAt: number,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${code}:${email.toLowerCase()}:${sessionId}:${issuedAt}`);
  const keyData = encoder.encode(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify an email code hash using constant-time comparison
 *
 * @param code - The 6-digit OTP code to verify
 * @param email - The user's email address
 * @param sessionId - The OTP session ID
 * @param issuedAt - The timestamp when the code was issued
 * @param storedHash - The hash stored in ChallengeStore
 * @param secret - The HMAC secret key
 */
export async function verifyEmailCodeHash(
  code: string,
  email: string,
  sessionId: string,
  issuedAt: number,
  storedHash: string,
  secret: string
): Promise<boolean> {
  const computedHash = await hashEmailCode(code, email, sessionId, issuedAt, secret);
  return constantTimeEqual(computedHash, storedHash);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Hash an email address using SHA-256 for logging purposes
 */
export async function hashEmail(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
