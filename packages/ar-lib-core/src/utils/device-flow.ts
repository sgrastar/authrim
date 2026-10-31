/**
 * Device Flow Utilities
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628
 */

import type { DeviceCodeMetadata } from '../types/oidc';
import { randomCharacters, type RandomBytesSource } from './unbiased-random';

/**
 * Generate a device code (opaque, unique identifier)
 * Uses UUID v4 for uniqueness and unpredictability
 *
 * @returns Device code string (UUID v4)
 */
export function generateDeviceCode(): string {
  return crypto.randomUUID();
}

/**
 * The alphabets a user code can be drawn from (`device_flow.user_code_charset`).
 *
 * - BASE31 is the alphabet the endpoint has always used: it leaves out 0, O, 1, I and L, which are
 *   easy to confuse when read from a screen.
 * - BASE20 is the consonant alphabet RFC 8628 section 6.1 gives as its example.
 * - NUMERIC suits a device whose user can only enter digits.
 */
export const USER_CODE_CHARSETS = {
  BASE31: '23456789ABCDEFGHJKMNPQRSTUVWXYZ',
  BASE20: 'BCDFGHJKLMNPQRSTVWXZ',
  NUMERIC: '0123456789',
} as const;

export type UserCodeCharsetName = keyof typeof USER_CODE_CHARSETS;

/** The user code charset names, in the order the setting offers them. */
export const USER_CODE_CHARSET_NAMES = Object.keys(USER_CODE_CHARSETS) as UserCodeCharsetName[];

/** The shortest and longest user code the setting allows (characters, separators not counted). */
export const USER_CODE_MIN_LENGTH = 4;
export const USER_CODE_MAX_LENGTH = 16;

/** A user code is shown in groups of this many characters, separated by a hyphen. */
export const USER_CODE_GROUP_SIZE = 4;

/**
 * The least entropy (bits) a user code must carry: `length * log2(alphabet size)`. A user code is
 * guessed through the verification page, so RFC 8628 section 6.1 ties its size to the attempts a
 * client can make during its lifetime. The floor is held in code, whatever is stored.
 */
export const USER_CODE_MIN_ENTROPY_BITS = 34;

/** The user code format an unconfigured tenant gets: the alphabet and length used since the start. */
export const DEFAULT_USER_CODE_CHARSET: UserCodeCharsetName = 'BASE31';
export const DEFAULT_USER_CODE_LENGTH = 8;

/** The user code settings of a tenant. */
export interface UserCodeFormat {
  userCodeCharset: UserCodeCharsetName;
  userCodeLength: number;
}

export function isUserCodeCharsetName(value: unknown): value is UserCodeCharsetName {
  return typeof value === 'string' && Object.hasOwn(USER_CODE_CHARSETS, value);
}

/** Entropy (bits) of a code of `length` characters drawn uniformly from the charset. */
export function userCodeEntropyBits(charset: UserCodeCharsetName, length: number): number {
  return length * Math.log2(USER_CODE_CHARSETS[charset].length);
}

/**
 * The shortest length that carries enough entropy with this charset (BASE31: 7, BASE20: 8,
 * NUMERIC: 11), never below the setting's own minimum.
 */
export function minimumUserCodeLength(charset: UserCodeCharsetName): number {
  let length = USER_CODE_MIN_LENGTH;
  while (userCodeEntropyBits(charset, length) < USER_CODE_MIN_ENTROPY_BITS) length += 1;
  return length;
}

/** Whether a charset and length together are a user code format the endpoint may issue. */
export function isUserCodeFormatAllowed(charset: unknown, length: unknown): boolean {
  return (
    isUserCodeCharsetName(charset) &&
    typeof length === 'number' &&
    Number.isInteger(length) &&
    length >= USER_CODE_MIN_LENGTH &&
    length <= USER_CODE_MAX_LENGTH &&
    userCodeEntropyBits(charset, length) >= USER_CODE_MIN_ENTROPY_BITS
  );
}

/**
 * Why a charset and length cannot be saved together, or null. Names the minimum length for the
 * charset, so an admin knows what to change.
 */
export function userCodeFormatProblem(charset: UserCodeCharsetName, length: number): string | null {
  if (length < USER_CODE_MIN_LENGTH || length > USER_CODE_MAX_LENGTH) {
    return `device_flow.user_code_length must be between ${USER_CODE_MIN_LENGTH} and ${USER_CODE_MAX_LENGTH}`;
  }
  const minimum = minimumUserCodeLength(charset);
  if (length < minimum) {
    const bits = userCodeEntropyBits(charset, length).toFixed(1);
    return `device_flow.user_code_length (${length}) is too short for device_flow.user_code_charset ${charset}: a user code needs at least ${USER_CODE_MIN_ENTROPY_BITS} bits of entropy (${length} characters give ${bits} bits), which takes at least ${minimum} characters with ${charset}`;
  }
  return null;
}

/**
 * The user code format to use for the values a tenant has (a stored value, an environment
 * variable or the default). The pair has to be allowed as a whole: when it is not (an unknown
 * charset, a length out of range, or too little entropy) the default pair is used, not one value
 * of it, so a bad value can never lower the entropy below the floor.
 */
export function resolveUserCodeFormat(charset: unknown, length: unknown): UserCodeFormat {
  return isUserCodeFormatAllowed(charset, length)
    ? { userCodeCharset: charset as UserCodeCharsetName, userCodeLength: length as number }
    : { userCodeCharset: DEFAULT_USER_CODE_CHARSET, userCodeLength: DEFAULT_USER_CODE_LENGTH };
}

/** Characters people type between the groups of a code (hyphens of any kind, white space). */
const USER_CODE_SEPARATORS = /[\s\-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;

/**
 * The canonical form of a user code, which is what is stored and looked up: upper case, with the
 * separators people type or the display adds removed ("abcd-efgh" and "ABCD EFGH" are
 * "ABCDEFGH").
 */
export function normalizeUserCode(userCode: string): string {
  return userCode.replace(USER_CODE_SEPARATORS, '').toUpperCase();
}

/**
 * Whether a user code, in any of the forms people type, is well formed: 4 to 16 letters and
 * digits once the separators are gone. It deliberately says nothing about the alphabet or the
 * length the tenant issues now: the settings may have changed since the code was issued, so the
 * store decides whether the code exists.
 */
export function validateUserCodeFormat(userCode: string): boolean {
  return /^[A-Z0-9]{4,16}$/.test(normalizeUserCode(userCode));
}

/**
 * The display form of a user code: groups of 4 characters separated by a hyphen ("ABCD-EFGH",
 * "ABCD-EFGH-JKM", "ABCD" for 4 characters). Accepts any form `normalizeUserCode` reads.
 */
export function formatUserCode(userCode: string): string {
  const canonical = normalizeUserCode(userCode);
  const groups: string[] = [];
  for (let index = 0; index < canonical.length; index += USER_CODE_GROUP_SIZE) {
    groups.push(canonical.slice(index, index + USER_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Generate a user code (short, human-readable code)
 * RFC 8628 section 6.1: short, case-insensitive, drawn from a limited alphabet; the entropy has to
 * stand against guessing during the lifetime of the code.
 *
 * The alphabet and length come from the tenant's settings (`device_flow.user_code_charset`,
 * `device_flow.user_code_length`); without them it is today's format: 8 characters of BASE31,
 * "WDJB-MJHT". The code is shown in groups of 4 characters separated by a hyphen. A format below
 * the entropy floor is refused whatever the caller passes.
 *
 * @param format - The tenant's user code settings (defaults to BASE31 x 8)
 * @param source - Random byte source (defaults to Web Crypto; replaceable in tests)
 * @returns User code string in the display form
 */
export function generateUserCode(
  format: UserCodeFormat = {
    userCodeCharset: DEFAULT_USER_CODE_CHARSET,
    userCodeLength: DEFAULT_USER_CODE_LENGTH,
  },
  source?: RandomBytesSource
): string {
  if (!isUserCodeFormatAllowed(format.userCodeCharset, format.userCodeLength)) {
    throw new RangeError(
      `User code format ${String(format.userCodeCharset)} x ${String(format.userCodeLength)} is not allowed (at least ${USER_CODE_MIN_ENTROPY_BITS} bits of entropy)`
    );
  }
  // Rejection sampling: `byte % size` alone would favour the first characters of the alphabet
  return formatUserCode(
    randomCharacters(USER_CODE_CHARSETS[format.userCodeCharset], format.userCodeLength, source)
  );
}

/**
 * Check if device code has expired
 *
 * @param metadata - Device code metadata
 * @returns true if expired, false otherwise
 */
export function isDeviceCodeExpired(metadata: DeviceCodeMetadata): boolean {
  return Date.now() > metadata.expires_at;
}

/**
 * Check if device is polling too frequently (slow down detection)
 * RFC 8628: Clients should wait at least the interval specified
 *
 * @param metadata - Device code metadata
 * @param minimumInterval - Minimum interval in seconds (default 5)
 * @returns true if polling too fast, false otherwise
 */
export function isDeviceFlowPollingTooFast(
  metadata: DeviceCodeMetadata,
  minimumInterval: number = 5
): boolean {
  if (!metadata.last_poll_at) {
    return false;
  }

  const timeSinceLastPoll = Date.now() - metadata.last_poll_at;
  const minimumIntervalMs = minimumInterval * 1000;

  return timeSinceLastPoll < minimumIntervalMs;
}

/**
 * Get verification URI with user code embedded
 * Useful for QR codes and direct links
 *
 * @param baseUri - Base verification URI
 * @param userCode - User code to embed
 * @param tenantHint - Optional tenant hint for UI branding (UX only, untrusted)
 * @returns Complete verification URI
 */
export function getVerificationUriComplete(
  baseUri: string,
  userCode: string,
  tenantHint?: string
): string {
  const url = new URL(baseUri);
  url.searchParams.set('user_code', userCode);
  // Add tenant_hint for UI branding (UX only, security is determined by Host header)
  if (tenantHint && tenantHint !== 'default') {
    url.searchParams.set('tenant_hint', tenantHint);
  }
  return url.toString();
}

/**
 * Device Flow Constants
 * RFC 8628 recommended values
 */
export const DEVICE_FLOW_CONSTANTS = {
  // Code expiration time in seconds (5-10 minutes recommended)
  DEFAULT_EXPIRES_IN: 600, // 10 minutes
  MIN_EXPIRES_IN: 300, // 5 minutes
  MAX_EXPIRES_IN: 1800, // 30 minutes

  // Polling interval in seconds
  DEFAULT_INTERVAL: 5, // 5 seconds
  MIN_INTERVAL: 1, // 1 second (not recommended)
  MAX_INTERVAL: 60, // 1 minute

  // Slow down increment when polling too fast
  SLOW_DOWN_INCREMENT: 5, // Add 5 seconds to interval

  // Maximum poll attempts before giving up
  MAX_POLL_COUNT: 120, // 120 polls × 5s = 10 minutes max
} as const;
