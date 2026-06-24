/**
 * Plugin Security Utilities
 *
 * Security-focused utilities for plugin configuration:
 * - Secret field extraction and encryption
 * - URL validation for external resources
 * - Recursive masking for sensitive data
 *
 * Security Design:
 * - Secret fields are encrypted at rest in KV using AES-GCM
 * - URLs are validated server-side for headless operation
 * - Masking is recursive to handle nested objects
 */

import { z } from 'zod';

// =============================================================================
// Secret Field Support
// =============================================================================

/**
 * Symbol for marking fields as secrets in Zod schemas
 *
 * Usage:
 * ```typescript
 * const schema = z.object({
 *   apiKey: z.string().describe('API Key').refine(() => true, { params: { secret: true } }),
 *   // Or use the helper:
 *   apiKey: secretField(z.string().describe('API Key')),
 * });
 * ```
 */
export const SECRET_FIELD_MARKER = Symbol('secretField');

/**
 * Mark a Zod field as a secret
 *
 * Secret fields will be:
 * - Encrypted when stored in KV
 * - Masked in API responses
 * - Not logged in audit trails
 *
 * @param schema - Zod schema to mark as secret
 * @returns Schema with secret metadata
 */
export function secretField<T extends z.ZodTypeAny>(schema: T): T {
  // Clone the schema and add secret metadata
  // Using _def manipulation as Zod doesn't have a native metadata API
  const cloned = schema as T & { _secret?: boolean };
  cloned._secret = true;
  return cloned;
}

/**
 * Check if a Zod field is marked as secret
 */
export function isSecretField(schema: z.ZodTypeAny): boolean {
  return (schema as z.ZodTypeAny & { _secret?: boolean })._secret === true;
}

/**
 * Extract secret field names from a Zod object schema
 *
 * @param schema - Zod object schema
 * @returns List of field names that are marked as secret
 */
export function extractSecretFields(schema: z.ZodTypeAny): string[] {
  const secretFields: string[] = [];

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (isSecretField(fieldSchema)) {
        secretFields.push(key);
      }
      // Handle unwrapped types (optional, default, etc.)
      let unwrapped = fieldSchema;
      while (
        unwrapped instanceof z.ZodOptional ||
        unwrapped instanceof z.ZodDefault ||
        unwrapped instanceof z.ZodNullable
      ) {
        unwrapped = unwrapped._def.innerType as z.ZodTypeAny;
      }
      if (isSecretField(unwrapped)) {
        secretFields.push(key);
      }
    }
  }

  return secretFields;
}

/**
 * Default secret field patterns for fallback detection
 *
 * Used when fields are not explicitly marked with secretField().
 * These patterns match common naming conventions for sensitive data.
 */
export const DEFAULT_SECRET_PATTERNS = [
  /apikey/i,
  /apisecret/i,
  /secretkey/i,
  /password/i,
  /token/i,
  /authtoken/i,
  /accesstoken/i,
  /refreshtoken/i,
  /privatekey/i,
  /clientsecret/i,
  /credential/i,
];

/**
 * Check if a field name matches secret patterns
 */
export function matchesSecretPattern(fieldName: string): boolean {
  return DEFAULT_SECRET_PATTERNS.some((pattern) => pattern.test(fieldName));
}

// =============================================================================
// URL Validation
// =============================================================================

/**
 * URL validation result
 */
export interface UrlValidationResult {
  /** Whether the URL is valid */
  valid: boolean;

  /** Reason for invalidity */
  reason?:
    | 'invalid_format'
    | 'disallowed_scheme'
    | 'disallowed_host'
    | 'blocklist'
    | 'private_ip'
    | 'too_long';

  /** Sanitized URL (if valid) */
  sanitized?: string;
}

/**
 * URL validation options
 */
export interface UrlValidationOptions {
  /** Allow data: URLs (for icons only, not logos) */
  allowDataUrl?: boolean;

  /** Allow http:// in addition to https:// */
  allowHttp?: boolean;

  /** Allowed domains (whitelist) */
  allowedDomains?: string[];

  /** Blocked domains (blacklist) */
  blockedDomains?: string[];

  /** Maximum URL length */
  maxLength?: number;

  /** Block private/internal IPs */
  blockPrivateIps?: boolean;
}

/**
 * Default blocked domains for security
 */
const BLOCKED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  'metadata.google.internal', // GCP metadata
  '169.254.169.254', // AWS/GCP metadata
  'metadata.azure.internal', // Azure metadata
];

/**
 * Validate an external URL for security
 *
 * Use cases:
 * - Plugin icon URLs
 * - Plugin logo URLs
 * - External documentation links
 *
 * Security considerations:
 * - Blocks javascript: and other dangerous schemes
 * - Blocks internal/metadata endpoints
 * - Validates URL format
 *
 * @param url - URL to validate
 * @param options - Validation options
 * @returns Validation result
 */
export function validateExternalUrl(
  url: string,
  options: UrlValidationOptions = {}
): UrlValidationResult {
  const {
    allowDataUrl = false,
    allowHttp = false,
    allowedDomains,
    blockedDomains = BLOCKED_DOMAINS,
    maxLength = 2048,
    blockPrivateIps = true,
  } = options;

  // Check length
  if (url.length > maxLength) {
    return { valid: false, reason: 'too_long' };
  }

  // Handle Lucide icon names (not URLs)
  if (!url.includes('://') && !url.startsWith('data:')) {
    // Assume it's a Lucide icon name, which is valid
    return { valid: true, sanitized: url };
  }

  // Handle data: URLs
  if (url.startsWith('data:')) {
    if (!allowDataUrl) {
      return { valid: false, reason: 'disallowed_scheme' };
    }
    // Validate data URL format (only allow images)
    if (!url.startsWith('data:image/')) {
      return { valid: false, reason: 'disallowed_scheme' };
    }
    // Limit data URL size (100KB base64 ≈ 133KB in data URL)
    if (url.length > 150000) {
      return { valid: false, reason: 'too_long' };
    }
    return { valid: true, sanitized: url };
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'invalid_format' };
  }

  // Check scheme
  const allowedSchemes = allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowedSchemes.includes(parsed.protocol)) {
    return { valid: false, reason: 'disallowed_scheme' };
  }

  // Check hostname
  const hostname = parsed.hostname.toLowerCase();

  // Block dangerous hosts
  const allBlockedDomains = [...blockedDomains];
  if (
    allBlockedDomains.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))
  ) {
    return { valid: false, reason: 'blocklist' };
  }

  // Check private IP ranges
  if (blockPrivateIps && isPrivateIp(hostname)) {
    return { valid: false, reason: 'private_ip' };
  }

  // Check allowed domains (if specified)
  if (allowedDomains && allowedDomains.length > 0) {
    const isAllowed = allowedDomains.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
    );
    if (!isAllowed) {
      return { valid: false, reason: 'disallowed_host' };
    }
  }

  // URL is valid
  return { valid: true, sanitized: parsed.href };
}

/**
 * Check if a hostname is a private/internal IP
 */
function isPrivateIp(hostname: string): boolean {
  // IPv4 private ranges
  const ipv4PrivateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^127\./,
    /^0\./,
    /^169\.254\./, // Link-local
  ];

  for (const range of ipv4PrivateRanges) {
    if (range.test(hostname)) {
      return true;
    }
  }

  // IPv6 private ranges (simplified)
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (
      ipv6 === '::1' || // Loopback
      ipv6.startsWith('fe80:') || // Link-local
      ipv6.startsWith('fc') || // Unique local
      ipv6.startsWith('fd') // Unique local
    ) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Recursive Masking
// =============================================================================

/**
 * Masking options
 */
export interface MaskOptions {
  /** Field names to mask (explicit list) */
  secretFields?: string[];

  /** Use pattern matching for field names */
  usePatternMatching?: boolean;

  /** Mask format for short values */
  shortMask?: string;

  /** Number of characters to show at start */
  showStart?: number;

  /** Number of characters to show at end */
  showEnd?: number;

  /** Maximum depth for recursive masking */
  maxDepth?: number;
}

const DEFAULT_MASK_OPTIONS: Required<MaskOptions> = {
  secretFields: [],
  usePatternMatching: true,
  shortMask: '****',
  showStart: 4,
  showEnd: 4,
  maxDepth: 20, // Maximum nesting depth for recursive masking
};

/**
 * Recursively mask sensitive fields in a configuration object
 *
 * Handles:
 * - Top-level fields
 * - Nested objects
 * - Arrays of objects
 *
 * @param config - Configuration object to mask
 * @param options - Masking options
 * @returns Masked configuration
 */
export function maskSensitiveFieldsRecursive(
  config: Record<string, unknown>,
  options: MaskOptions = {}
): Record<string, unknown> {
  const opts = { ...DEFAULT_MASK_OPTIONS, ...options };
  return maskObject(config, opts, 0);
}

function maskObject(
  obj: Record<string, unknown>,
  options: Required<MaskOptions>,
  depth: number
): Record<string, unknown> {
  if (depth > options.maxDepth) {
    return obj;
  }

  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const shouldMask =
      options.secretFields.includes(key) ||
      (options.usePatternMatching && matchesSecretPattern(key));

    if (shouldMask && typeof value === 'string') {
      masked[key] = maskString(value, options);
    } else if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        masked[key] = (value as unknown[]).map((item: unknown): unknown => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            return maskObject(item as Record<string, unknown>, options, depth + 1);
          }
          return item;
        });
      } else {
        masked[key] = maskObject(value as Record<string, unknown>, options, depth + 1);
      }
    } else {
      masked[key] = value;
    }
  }

  return masked;
}

function maskString(
  value: string,
  options: { shortMask: string; showStart: number; showEnd: number }
): string {
  const minLength = options.showStart + options.showEnd + 4; // At least 4 masked chars

  if (value.length < minLength) {
    return options.shortMask;
  }

  const start = value.substring(0, options.showStart);
  const end = value.substring(value.length - options.showEnd);
  return `${start}****${end}`;
}

// =============================================================================
// Encryption Utilities (for KV storage)
// =============================================================================

/**
 * Encrypted field wrapper
 *
 * Stored in KV to indicate encrypted fields:
 * ```json
 * {
 *   "_encrypted": ["apiKey", "secretKey"],
 *   "apiKey": "enc:v1:...",
 *   "publicId": "plain-value"
 * }
 * ```
 */
export interface EncryptedConfig {
  /** List of encrypted field names */
  _encrypted: string[];

  /** Configuration fields (encrypted ones have enc:v1: prefix) */
  [key: string]: unknown;
}

/** Default salt for plugin secret encryption */
const DEFAULT_ENCRYPTION_SALT = 'authrim-plugin-config-v1';

/**
 * Derive an AES-GCM encryption key from a secret string
 *
 * Uses PBKDF2 to derive a 256-bit key from the provided secret.
 * The salt can be customized via environment variable for additional security.
 *
 * @param secret - The secret string (e.g., from environment variable PLUGIN_ENCRYPTION_KEY)
 * @param salt - Optional custom salt (from PLUGIN_ENCRYPTION_SALT env var)
 * @returns CryptoKey for AES-GCM encryption/decryption
 *
 * @example
 * ```typescript
 * const key = await deriveEncryptionKey(env.PLUGIN_ENCRYPTION_KEY, env.PLUGIN_ENCRYPTION_SALT);
 * const encrypted = await encryptValue('my-api-key', key);
 * ```
 */
export async function deriveEncryptionKey(secret: string, salt?: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) {
    throw new Error('Encryption secret must be at least 32 characters');
  }

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Use provided salt or default for backwards compatibility
  const actualSalt = salt ?? DEFAULT_ENCRYPTION_SALT;
  const saltBytes = encoder.encode(actualSalt);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Get or create encryption key for plugin configuration
 *
 * Secret:
 * - PLUGIN_ENCRYPTION_KEY environment variable
 * Salt (optional):
 * - PLUGIN_ENCRYPTION_SALT environment variable
 * - Falls back to default salt for backwards compatibility
 *
 * @param env - Environment bindings
 * @returns CryptoKey for AES-GCM encryption/decryption
 * @throws Error if no encryption key is configured
 */
export async function getPluginEncryptionKey(env: {
  PLUGIN_ENCRYPTION_KEY?: string;
  PLUGIN_ENCRYPTION_SALT?: string;
}): Promise<CryptoKey> {
  const secret = env.PLUGIN_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error(
      'Plugin encryption key not configured. Set PLUGIN_ENCRYPTION_KEY environment variable.'
    );
  }

  // Pass salt from environment variable (undefined uses default)
  return deriveEncryptionKey(secret, env.PLUGIN_ENCRYPTION_SALT);
}

/**
 * Check if a value is encrypted
 */
export function isEncryptedValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

/**
 * Encrypt a string value using AES-GCM
 *
 * Format: enc:v1:{iv}:{ciphertext}
 * - iv: 12 bytes, base64 encoded
 * - ciphertext: base64 encoded
 *
 * Note: This requires a CryptoKey from KEY_MANAGER DO
 */
export async function encryptValue(value: string, key: CryptoKey): Promise<string> {
  // Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const encoder = new TextEncoder();
  const data = encoder.encode(value);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

  // Encode
  const ivBase64 = btoa(String.fromCharCode(...iv));
  const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));

  return `enc:v1:${ivBase64}:${ciphertextBase64}`;
}

/**
 * Decrypt a string value
 */
export async function decryptValue(encryptedValue: string, key: CryptoKey): Promise<string> {
  // Parse format
  const parts = encryptedValue.split(':');
  if (parts.length !== 4 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Invalid encrypted value format');
  }

  const ivBase64 = parts[2];
  const ciphertextBase64 = parts[3];

  // Decode
  const iv = new Uint8Array(
    atob(ivBase64)
      .split('')
      .map((c) => c.charCodeAt(0))
  );
  const ciphertext = new Uint8Array(
    atob(ciphertextBase64)
      .split('')
      .map((c) => c.charCodeAt(0))
  );

  // Decrypt
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  // Decode
  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}

/**
 * Encrypt secret fields in a configuration object
 *
 * @param config - Configuration object
 * @param secretFields - List of field names to encrypt
 * @param key - Encryption key from KEY_MANAGER
 * @returns Encrypted configuration with _encrypted metadata
 */
export async function encryptSecretFields(
  config: Record<string, unknown>,
  secretFields: string[],
  key: CryptoKey
): Promise<EncryptedConfig> {
  const result: EncryptedConfig = {
    _encrypted: [],
    ...config,
  };

  for (const field of secretFields) {
    const value = config[field];
    if (typeof value === 'string' && value.length > 0) {
      result[field] = await encryptValue(value, key);
      result._encrypted.push(field);
    }
  }

  return result;
}

/**
 * Decrypt secret fields in a configuration object
 *
 * @param config - Encrypted configuration
 * @param key - Decryption key from KEY_MANAGER
 * @returns Decrypted configuration
 */
export async function decryptSecretFields(
  config: EncryptedConfig,
  key: CryptoKey
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const encryptedFields = config._encrypted || [];

  for (const [field, value] of Object.entries(config)) {
    if (field === '_encrypted') {
      continue;
    }

    if (encryptedFields.includes(field) && isEncryptedValue(value)) {
      result[field] = await decryptValue(value as string, key);
    } else {
      result[field] = value;
    }
  }

  return result;
}
