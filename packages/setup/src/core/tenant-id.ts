import { randomBytes } from 'node:crypto';

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
    body += RANDOM_TENANT_ALPHABET[bytes[i % bytes.length] % RANDOM_TENANT_ALPHABET.length];
  }

  return body;
}

export function generateRandomTenantId(bodyLength: number = RANDOM_TENANT_BODY_LENGTH): string {
  return generateTenantIdFromBytes(randomBytes(bodyLength), bodyLength);
}
