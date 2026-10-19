import { randomInt } from 'node:crypto';

export const TENANT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const TENANT_ID_MAX_LENGTH = 63;
export const TENANT_ID_STRICT_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const RANDOM_TENANT_ALPHABET = 'abcdefghjkmnpqrstuvwxyz';
const RANDOM_TENANT_BODY_LENGTH = 12;

/**
 * The tenant ID the Admin database reserves for platform-wide rows. No tenant is created under it.
 * This repeats @authrim/ar-lib-core's PLATFORM_MAPPING_TENANT_ID and isReservedPlatformTenantId
 * (this file stays free of that package so the Web setup UI can mirror it); a test pins the two
 * to the same rule.
 */
export const RESERVED_PLATFORM_TENANT_ID = 'platform';

/** Whether `value` names the reserved platform ID once case and surrounding whitespace are ignored. */
export function isReservedTenantId(value: string): boolean {
  return value.trim().toLowerCase() === RESERVED_PLATFORM_TENANT_ID;
}

export function isValidTenantId(value: string): boolean {
  return TENANT_ID_STRICT_PATTERN.test(value) && !isReservedTenantId(value);
}

export function generateTenantIdFromBytes(
  bytes: Uint8Array,
  bodyLength: number = RANDOM_TENANT_BODY_LENGTH
): string {
  let body = '';

  for (let i = 0; i < bodyLength; i += 1) {
    const byte = bytes[i - Math.floor(i / bytes.length) * bytes.length] ?? 0;
    const index = Math.min(
      RANDOM_TENANT_ALPHABET.length - 1,
      Math.floor((byte / 256) * RANDOM_TENANT_ALPHABET.length)
    );
    body += RANDOM_TENANT_ALPHABET[index];
  }

  return body;
}

export function generateRandomTenantId(bodyLength: number = RANDOM_TENANT_BODY_LENGTH): string {
  let body = '';
  while (body.length < bodyLength) {
    body += RANDOM_TENANT_ALPHABET[randomInt(RANDOM_TENANT_ALPHABET.length)];
  }
  return body;
}
