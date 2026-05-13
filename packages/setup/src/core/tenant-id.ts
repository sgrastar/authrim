import { randomInt } from 'node:crypto';

export const TENANT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const TENANT_ID_MAX_LENGTH = 63;
export const TENANT_ID_STRICT_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const RANDOM_TENANT_ALPHABET = 'abcdefghjkmnpqrstuvwxyz';
const RANDOM_TENANT_BODY_LENGTH = 12;

export function isValidTenantId(value: string): boolean {
  return TENANT_ID_STRICT_PATTERN.test(value);
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
