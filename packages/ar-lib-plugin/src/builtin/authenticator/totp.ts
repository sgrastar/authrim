/**
 * TOTP Authenticator Plugin
 *
 * Time-based One-Time Password (RFC 6238) implementation.
 * Compatible with Google Authenticator, Authy, Microsoft Authenticator, etc.
 *
 * Security features:
 * - HMAC-SHA1/SHA256/SHA512 support
 * - Configurable time step (default: 30 seconds)
 * - Time drift tolerance (default: ±1 step)
 * - Rate limiting awareness
 * - Secure secret generation
 */

import { z } from 'zod';
import type { AuthrimPlugin, PluginContext, HealthStatus } from '../../core/types';
import type {
  AuthenticatorHandler,
  AuthChallengeParams,
  AuthChallengeResult,
  AuthVerifyParams,
  AuthVerifyResult,
} from '../../core/registry';
import { CapabilityRegistry } from '../../core/registry';

// =============================================================================
// Configuration Schema
// =============================================================================

/**
 * TOTP configuration schema
 *
 * Each field uses .describe() for Admin UI display.
 */
export const TOTPConfigSchema = z.object({
  issuer: z
    .string()
    .min(1)
    .default('Authrim')
    .describe('Issuer name displayed in authenticator apps (organization or service name)'),

  algorithm: z
    .enum(['sha1', 'sha256', 'sha512'])
    .default('sha1')
    .describe(
      'HMAC algorithm. sha1 has the best compatibility (Google Authenticator, etc.). Use sha256/sha512 for stricter security requirements'
    ),

  digits: z
    .literal(6)
    .or(z.literal(8))
    .default(6)
    .describe('Number of OTP code digits. 6 digits is standard, 8 digits offers higher security'),

  period: z
    .number()
    .int()
    .min(15)
    .max(120)
    .default(30)
    .describe('Code refresh interval (seconds). 30 seconds is standard. Shorter increases security, longer increases convenience'),

  window: z
    .number()
    .int()
    .min(0)
    .max(5)
    .default(1)
    .describe(
      'Time drift tolerance (±steps). 1 = allows ±30 seconds. 0 is strict but prone to failures from clock skew'
    ),

  secretLength: z
    .number()
    .int()
    .min(16)
    .max(64)
    .default(20)
    .describe('Secret key length (bytes). 20 bytes = 160 bits is RFC recommended'),

  allowSetupDuringRegistration: z
    .boolean()
    .default(true)
    .describe('Allow TOTP setup during user registration'),

  requireVerificationBeforeEnable: z
    .boolean()
    .default(true)
    .describe('Require verification code confirmation before enabling TOTP (recommended: true)'),
});

export type TOTPConfig = z.infer<typeof TOTPConfigSchema>;

// =============================================================================
// TOTP Plugin Implementation
// =============================================================================

/**
 * TOTP Authenticator Plugin
 *
 * Implements RFC 6238 Time-based One-Time Password authentication.
 */
export const totpAuthenticatorPlugin: AuthrimPlugin<TOTPConfig> = {
  id: 'authenticator-totp',
  version: '1.0.0',
  capabilities: ['authenticator.totp'],
  official: true,
  configSchema: TOTPConfigSchema,

  meta: {
    // Required fields
    name: 'TOTP Authenticator',
    description:
      'Time-based One-Time Password authentication. Compatible with Google Authenticator, Authy, Microsoft Authenticator, and more.',
    category: 'authentication',

    // Author (official plugin)
    author: {
      name: 'Authrim',
      url: 'https://authrim.com',
    },
    license: 'MIT',

    // Display
    icon: 'shield-check',
    tags: ['totp', 'otp', '2fa', 'mfa', 'authenticator', 'google-authenticator'],

    // Documentation
    documentationUrl: 'https://datatracker.ietf.org/doc/html/rfc6238',
    repositoryUrl: 'https://github.com/sgrastar/authrim',

    // Compatibility
    minAuthrimVersion: '1.0.0',

    // Status
    stability: 'stable',

    // Admin notes
    adminNotes: `
## Configuration Tips
- algorithm: Google Authenticator only supports sha1. Microsoft Authenticator also supports sha256
- period: Setting to 60 seconds or more allows more time for code entry, but reduces security
- window: Setting to 2 or more improves tolerance for clock skew, but increases replay attack risk

## Known Limitations
- QR code generation must be done client-side (returns otpauth:// URI)
    `.trim(),
  },

  register(registry: CapabilityRegistry, config: TOTPConfig) {
    const handler = createTOTPHandler(config);
    registry.registerAuthenticator('totp', handler, this.id);
  },

  async initialize(ctx: PluginContext, config: TOTPConfig): Promise<void> {
    ctx.logger.info('[totp] TOTP Authenticator initialized', {
      issuer: config.issuer,
      algorithm: config.algorithm,
      digits: config.digits,
      period: config.period,
    });
  },

  async healthCheck(): Promise<HealthStatus> {
    // TOTP is a local computation, always healthy
    return {
      status: 'healthy',
      message: 'TOTP authenticator is ready',
    };
  },
};

// =============================================================================
// Handler Implementation
// =============================================================================

function createTOTPHandler(config: TOTPConfig): AuthenticatorHandler {
  return {
    /**
     * Start TOTP setup/verification challenge
     *
     * For setup: Returns secret and QR code data
     * For verification: Returns challenge ID only
     */
    async startChallenge(params: AuthChallengeParams): Promise<AuthChallengeResult> {
      const isSetup = params.metadata?.setup === true;
      const challengeId = generateChallengeId();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

      if (isSetup) {
        // Generate new TOTP secret for setup
        const secret = generateSecret(config.secretLength);
        const accountName = (params.metadata?.email as string) || params.userId;

        // Generate otpauth:// URI for QR code
        const otpauthUri = generateOtpauthUri({
          secret,
          issuer: config.issuer,
          accountName,
          algorithm: config.algorithm,
          digits: config.digits,
          period: config.period,
        });

        return {
          challengeId,
          challenge: {
            type: 'totp_setup',
            secret: base32Encode(secret), // Base32 encoded for display
            otpauthUri,
            algorithm: config.algorithm,
            digits: config.digits,
            period: config.period,
            // Note: Store raw secret bytes in metadata for verification
            _secretBytes: Array.from(secret),
          },
          expiresAt,
        };
      }

      // Verification challenge (secret should be retrieved from user's stored credential)
      return {
        challengeId,
        challenge: {
          type: 'totp_verify',
          digits: config.digits,
          period: config.period,
        },
        expiresAt,
      };
    },

    /**
     * Verify TOTP code
     */
    async verifyResponse(params: AuthVerifyParams): Promise<AuthVerifyResult> {
      const code = params.response as { code: string; secret?: string | number[] };

      if (!code?.code || typeof code.code !== 'string') {
        return {
          success: false,
          error: 'Invalid TOTP code format',
        };
      }

      // Validate code format
      const codeRegex = config.digits === 6 ? /^\d{6}$/ : /^\d{8}$/;
      if (!codeRegex.test(code.code)) {
        return {
          success: false,
          error: `TOTP code must be ${config.digits} digits`,
        };
      }

      // Get secret (either from setup challenge or stored credential)
      let secretBytes: Uint8Array;

      if (code.secret) {
        // Setup verification: secret provided in response
        if (Array.isArray(code.secret)) {
          secretBytes = new Uint8Array(code.secret);
        } else if (typeof code.secret === 'string') {
          secretBytes = base32Decode(code.secret);
        } else {
          return {
            success: false,
            error: 'Invalid secret format',
          };
        }
      } else {
        // Normal verification: secret should be in params.response.storedSecret
        const storedSecret = (params.response as { storedSecret?: string })?.storedSecret;
        if (!storedSecret) {
          return {
            success: false,
            error: 'No TOTP secret available for verification',
          };
        }
        secretBytes = base32Decode(storedSecret);
      }

      // Verify TOTP code with time window
      const isValid = await verifyTOTP({
        code: code.code,
        secret: secretBytes,
        algorithm: config.algorithm,
        digits: config.digits,
        period: config.period,
        window: config.window,
      });

      if (isValid) {
        return {
          success: true,
          credentialId: params.challengeId,
        };
      }

      return {
        success: false,
        error: 'Invalid TOTP code',
      };
    },

    /**
     * Check if TOTP is available for user
     */
    async isAvailable(_userId: string): Promise<boolean> {
      // This should check if user has TOTP set up
      // For now, return true - actual implementation would check DB
      return true;
    },
  };
}

// =============================================================================
// TOTP Core Functions (RFC 6238)
// =============================================================================

/**
 * Generate TOTP code (async - uses Web Crypto API)
 */
async function generateTOTP(params: {
  secret: Uint8Array;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  digits: number;
  period: number;
  timestamp?: number;
}): Promise<string> {
  const { secret, algorithm, digits, period, timestamp = Date.now() } = params;

  // Calculate time counter (RFC 6238 Section 4.2)
  const counter = Math.floor(timestamp / 1000 / period);

  // Convert counter to 8-byte big-endian buffer
  const counterBuffer = new ArrayBuffer(8);
  const counterView = new DataView(counterBuffer);
  counterView.setBigUint64(0, BigInt(counter), false); // Big-endian

  // Calculate HMAC using Web Crypto API
  const hmac = await hmacSha(algorithm, secret, new Uint8Array(counterBuffer));

  // Dynamic truncation (RFC 4226 Section 5.4)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  // Generate OTP
  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

/**
 * Verify TOTP code with time window (async)
 */
async function verifyTOTP(params: {
  code: string;
  secret: Uint8Array;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  digits: number;
  period: number;
  window: number;
}): Promise<boolean> {
  const { code, secret, algorithm, digits, period, window } = params;
  const now = Date.now();

  // Check current time and window steps before/after
  for (let i = -window; i <= window; i++) {
    const timestamp = now + i * period * 1000;
    const expected = await generateTOTP({ secret, algorithm, digits, period, timestamp });

    // Constant-time comparison
    if (constantTimeEqual(code, expected)) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Cryptographic Helpers (Web Crypto API)
// =============================================================================

/**
 * HMAC calculation using Web Crypto API
 *
 * Uses crypto.subtle for secure HMAC computation.
 * Supports SHA-1, SHA-256, and SHA-512.
 */
async function hmacSha(
  algorithm: 'sha1' | 'sha256' | 'sha512',
  key: Uint8Array,
  message: Uint8Array
): Promise<Uint8Array> {
  // Map algorithm names to Web Crypto API format
  const algoMap: Record<string, string> = {
    sha1: 'SHA-1',
    sha256: 'SHA-256',
    sha512: 'SHA-512',
  };

  const hashAlgo = algoMap[algorithm];

  // Import key for HMAC
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: hashAlgo },
    false,
    ['sign']
  );

  // Calculate HMAC
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, message);

  return new Uint8Array(signature);
}

/**
 * Constant-time string comparison
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

// =============================================================================
// Secret Generation and Encoding
// =============================================================================

/**
 * Generate cryptographically secure random secret
 */
function generateSecret(length: number): Uint8Array {
  const secret = new Uint8Array(length);
  crypto.getRandomValues(secret);
  return secret;
}

/**
 * Generate unique challenge ID
 */
function generateChallengeId(): string {
  return `totp_${crypto.randomUUID()}`;
}

/**
 * Base32 alphabet (RFC 4648)
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode bytes to Base32 (RFC 4648)
 */
function base32Encode(data: Uint8Array): string {
  let result = '';
  let buffer = 0;
  let bitsInBuffer = 0;

  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;

    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      const index = (buffer >> bitsInBuffer) & 0x1f;
      result += BASE32_ALPHABET[index];
    }
  }

  // Handle remaining bits
  if (bitsInBuffer > 0) {
    const index = (buffer << (5 - bitsInBuffer)) & 0x1f;
    result += BASE32_ALPHABET[index];
  }

  return result;
}

/**
 * Decode Base32 to bytes (RFC 4648)
 */
function base32Decode(encoded: string): Uint8Array {
  // Remove spaces and convert to uppercase
  const normalized = encoded.replace(/\s/g, '').toUpperCase();

  const result: number[] = [];
  let buffer = 0;
  let bitsInBuffer = 0;

  for (const char of normalized) {
    // Skip padding
    if (char === '=') continue;

    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Base32 character: ${char}`);
    }

    buffer = (buffer << 5) | index;
    bitsInBuffer += 5;

    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      result.push((buffer >> bitsInBuffer) & 0xff);
    }
  }

  return new Uint8Array(result);
}

// =============================================================================
// OTPAuth URI Generation
// =============================================================================

/**
 * Generate otpauth:// URI for QR code
 *
 * Format: otpauth://totp/ISSUER:ACCOUNT?secret=...&issuer=...&algorithm=...&digits=...&period=...
 */
function generateOtpauthUri(params: {
  secret: Uint8Array;
  issuer: string;
  accountName: string;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  digits: number;
  period: number;
}): string {
  const { secret, issuer, accountName, algorithm, digits, period } = params;

  // Encode secret as Base32
  const secretBase32 = base32Encode(secret);

  // Build label (issuer:account)
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;

  // Build query parameters
  const queryParams = new URLSearchParams({
    secret: secretBase32,
    issuer: issuer,
    algorithm: algorithm.toUpperCase(),
    digits: digits.toString(),
    period: period.toString(),
  });

  return `otpauth://totp/${label}?${queryParams.toString()}`;
}

// =============================================================================
// Export
// =============================================================================

export default totpAuthenticatorPlugin;
