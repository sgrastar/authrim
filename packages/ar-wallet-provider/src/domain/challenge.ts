/**
 * Stateless challenges. `base64url(random(24) || expiresAt(8, big-endian seconds) || mac(16))`, 64
 * ASCII
 * characters. The MAC is HMAC-SHA-256 over a label, the environment, the random part and the
 * expiry, so
 * `/challenge` stores nothing. A challenge is *freshness*: single use comes from the commits of the
 * operations that accept it (registration claims it, an assertion's counter advances).
 */

import { concat, equalBytes, fromBase64Url, toBase64Url, utf8, type Bytes } from './bytes';

const LABEL = 'wp-challenge/v1';
const RANDOM_LENGTH = 24;
const MAC_LENGTH = 16;

export type ChallengeStatus = 'ok' | 'invalid' | 'expired';

async function mac(
  secret: Bytes,
  environment: string,
  random: Bytes,
  expires: Bytes
): Promise<Bytes> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const full = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      concat(utf8(LABEL), utf8('\n' + environment + '\n'), random, expires)
    )
  );
  return full.slice(0, MAC_LENGTH);
}

function expiryBytes(seconds: number): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(seconds));
  return out;
}

export async function createChallenge(input: {
  secret: Bytes;
  environment: string;
  now: number;
  ttlSeconds: number;
  random?: Bytes;
}): Promise<string> {
  const random = input.random ?? crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  if (random.length !== RANDOM_LENGTH || input.secret.length < 32)
    throw new Error('challenge_input_invalid');
  const expires = expiryBytes(input.now + input.ttlSeconds);
  return toBase64Url(
    concat(random, expires, await mac(input.secret, input.environment, random, expires))
  );
}

/** `secrets` holds the current key first and the previous generation after it. */
export async function checkChallenge(input: {
  challenge: string;
  secrets: readonly Bytes[];
  environment: string;
  now: number;
}): Promise<ChallengeStatus> {
  if (!Number.isSafeInteger(input.now) || input.challenge.length > 128) return 'invalid';
  const bytes = fromBase64Url(input.challenge);
  if (!bytes || bytes.length !== RANDOM_LENGTH + 8 + MAC_LENGTH) return 'invalid';
  const random = bytes.slice(0, RANDOM_LENGTH);
  const expires = bytes.slice(RANDOM_LENGTH, RANDOM_LENGTH + 8);
  const given = bytes.slice(RANDOM_LENGTH + 8);
  let matched = false;
  for (const secret of input.secrets) {
    if (
      secret.length >= 32 &&
      equalBytes(given, await mac(secret, input.environment, random, expires))
    )
      matched = true;
  }
  if (!matched) return 'invalid';
  const expiresAt = Number(new DataView(expires.buffer, expires.byteOffset, 8).getBigUint64(0));
  return input.now <= expiresAt ? 'ok' : 'expired';
}
