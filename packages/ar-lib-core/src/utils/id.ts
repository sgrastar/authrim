/**
 * ID Generation Utilities
 *
 * Supports multiple ID formats for user IDs:
 * - uuid: UUID v4 (default for internal IDs, 36 chars with hyphens)
 * - nanoid: NanoID (URL-safe, 21 chars, default for user IDs)
 */

/**
 * Supported user ID formats
 */
export type UserIdFormat = 'uuid' | 'nanoid';

/**
 * Default user ID format
 */
export const DEFAULT_USER_ID_FORMAT: UserIdFormat = 'nanoid';

/**
 * NanoID length (21 characters = 126 bits of entropy, similar to UUID v4's 122 bits)
 */
const NANOID_LENGTH = 21;

/**
 * NanoID alphabet for URL-safe IDs (same as nanoid default)
 */
const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

const PERSISTED_USER_ID_PATTERN = /^(?:[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}|[A-Za-z0-9_-]{21})$/u;

/**
 * Generate a NanoID using Web Crypto API
 * This implementation matches the nanoid package output format
 */
function generateNanoId(size: number = NANOID_LENGTH): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += NANOID_ALPHABET[bytes[i] & 63];
  }
  return id;
}

/**
 * Generate a user ID based on the specified format
 * Use this for end-user identifiable IDs (user_id in OIDC sub claim, etc.)
 *
 * @param format - The ID format to use ('uuid' or 'nanoid')
 * @returns Generated user ID string
 */
export function generateUserId(format: UserIdFormat = DEFAULT_USER_ID_FORMAT): string {
  switch (format) {
    case 'nanoid':
      return generateNanoId(NANOID_LENGTH);
    case 'uuid':
      return crypto.randomUUID();
    default:
      // Fallback to default format for unknown values
      return generateNanoId(NANOID_LENGTH);
  }
}

/**
 * Validate if a string matches a user ID format
 *
 * @param id - The ID to validate
 * @param format - The expected format (optional, validates against any format if not specified)
 * @returns true if the ID matches the expected format
 */
export function isValidUserId(id: string, format?: UserIdFormat): boolean {
  if (!id || typeof id !== 'string') {
    return false;
  }

  // UUID v4 pattern: 8-4-4-4-12 hex characters
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // NanoID pattern: URL-safe characters (A-Za-z0-9_-), typically 21 chars
  const nanoidPattern = /^[A-Za-z0-9_-]{21}$/;

  if (format === 'uuid') {
    return uuidPattern.test(id);
  }

  if (format === 'nanoid') {
    return nanoidPattern.test(id);
  }

  // If no format specified, accept either
  return uuidPattern.test(id) || nanoidPattern.test(id);
}

/** Validate the legacy-safe and generated forms accepted at persisted runtime boundaries. */
export function isValidPersistedUserId(id: unknown): id is string {
  return typeof id === 'string' && PERSISTED_USER_ID_PATTERN.test(id);
}

/** Validate the canonical account ID derived from a persisted user ID. */
export function isCanonicalAccountIdForUser(accountId: unknown, userId: unknown): boolean {
  return (
    typeof accountId === 'string' &&
    isValidPersistedUserId(userId) &&
    accountId === `account:${userId}`
  );
}

/**
 * KV namespace interface for user ID format retrieval
 */
interface KVNamespace {
  get(key: string): Promise<string | null>;
}

interface UserIdFormatEnv {
  USER_ID_FORMAT?: string;
}

function parseUserIdFormat(value: unknown): UserIdFormat | null {
  return value === 'uuid' || value === 'nanoid' ? value : null;
}

function requireTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

/**
 * Get user ID format from tenant settings in KV storage
 *
 * @param kv - The KV namespace (AUTHRIM_CONFIG)
 * @param tenantId - The tenant ID
 * @returns The configured user ID format, or default if not set
 */
export async function getUserIdFormatFromSettings(
  kv: KVNamespace | undefined,
  tenantId: string,
  env?: UserIdFormatEnv
): Promise<UserIdFormat> {
  const normalizedTenantId = requireTenantId(tenantId, 'getUserIdFormatFromSettings');
  const envFormat = parseUserIdFormat(env?.USER_ID_FORMAT);
  if (envFormat) {
    return envFormat;
  }

  if (!kv) {
    return DEFAULT_USER_ID_FORMAT;
  }

  try {
    const kvData = await kv.get(`settings:tenant:${normalizedTenantId}:tenant`);
    if (kvData) {
      const settings = JSON.parse(kvData) as Record<string, unknown>;
      const format = parseUserIdFormat(settings['tenant.user_id_format']);
      if (format) {
        return format;
      }
    }
  } catch {
    // Fall back to default on any error
  }

  return DEFAULT_USER_ID_FORMAT;
}

/**
 * Generate a user ID based on tenant settings
 * Convenience function that reads the format from KV and generates the ID
 *
 * @param kv - The KV namespace (AUTHRIM_CONFIG)
 * @param tenantId - The tenant ID
 * @returns Generated user ID string
 */
export async function generateUserIdFromSettings(
  kv: KVNamespace | undefined,
  tenantId: string,
  env?: UserIdFormatEnv
): Promise<string> {
  const format = await getUserIdFormatFromSettings(kv, tenantId, env);
  return generateUserId(format);
}
