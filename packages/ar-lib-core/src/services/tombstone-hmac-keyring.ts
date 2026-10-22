/**
 * The keys of deleted accounts' email fingerprints (TOMBSTONE_HMAC_KEYRING), apart from the
 * lookup directory's keys so that a lookup key rotation never hides a deletion record.
 *
 * The secret is JSON: `{"current": <generation>, "keys": {"<generation>": "<secret>", ...}}`.
 * New records are made with the current generation; every generation listed is read. A key is
 * removed only once every record made with it is past its retention (at most 3650 days).
 *
 * Rotating takes two deploys, so that no Worker is asked about a generation it cannot read:
 * first add the new generation (current unchanged) and deploy; then make it current and deploy.
 */

import type { LookupBlindIndexKey } from './lookup-directory/blind-index';

export interface TombstoneHmacKeys {
  /** The key new records are made with. */
  writeKey: LookupBlindIndexKey;
  /** Every key a record may have been made with (the current one first). */
  readKeys: LookupBlindIndexKey[];
}

const MAX_KEYS = 32;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_LENGTH = 512;
const GENERATION = /^[1-9][0-9]{0,8}$/u;
const encoder = new TextEncoder();
const cache = new Map<string, TombstoneHmacKeys>();

/** Parses the keyring secret, or throws `tombstone_hmac_keyring_invalid`. */
export function parseTombstoneHmacKeyring(value: string): TombstoneHmacKeys {
  const cached = cache.get(value);
  if (cached) return cached;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('tombstone_hmac_keyring_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tombstone_hmac_keyring_invalid');
  }
  const { current, keys } = parsed as { current?: unknown; keys?: unknown };
  if (
    typeof current !== 'number' ||
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !keys ||
    typeof keys !== 'object' ||
    Array.isArray(keys) ||
    Object.keys(parsed as object).some((key) => key !== 'current' && key !== 'keys')
  ) {
    throw new Error('tombstone_hmac_keyring_invalid');
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_KEYS) {
    throw new Error('tombstone_hmac_keyring_invalid');
  }
  const readKeys: LookupBlindIndexKey[] = [];
  const secrets = new Set<string>();
  for (const [generation, secret] of entries) {
    if (
      !GENERATION.test(generation) ||
      typeof secret !== 'string' ||
      secret.length > MAX_SECRET_LENGTH ||
      encoder.encode(secret).byteLength < MIN_SECRET_BYTES ||
      secrets.has(secret)
    ) {
      throw new Error('tombstone_hmac_keyring_invalid');
    }
    secrets.add(secret);
    readKeys.push({ generation: Number(generation), secret });
  }
  const writeKey = readKeys.find((key) => key.generation === current);
  if (!writeKey) throw new Error('tombstone_hmac_keyring_invalid');
  const keyring: TombstoneHmacKeys = {
    writeKey,
    readKeys: [writeKey, ...readKeys.filter((key) => key !== writeKey)],
  };
  cache.set(value, keyring);
  return keyring;
}

/** The environment's tombstone keys, or throws when the secret is missing or malformed. */
export function loadTombstoneHmacKeysFromEnv(env: {
  TOMBSTONE_HMAC_KEYRING?: string;
}): TombstoneHmacKeys {
  const value = env.TOMBSTONE_HMAC_KEYRING;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('tombstone_hmac_keyring_unavailable');
  }
  return parseTombstoneHmacKeyring(value);
}
