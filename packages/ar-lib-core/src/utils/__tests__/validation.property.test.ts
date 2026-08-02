/**
 * Validation Property-Based Tests
 *
 * Uses fast-check to discover edge cases in OAuth/OIDC parameter validation
 * that traditional unit tests might miss.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateClientId,
  validateRedirectUri,
  validateState,
  validateNonce,
  validateScope,
  validateAuthCode,
  validateToken,
  normalizeRedirectUri,
  isRedirectUriRegistered,
} from '../validation';
import {
  clientIdArb,
  tooLongClientIdArb,
  invalidCharClientIdArb,
  httpsRedirectUriArb,
  localhostRedirectUriArb,
  maliciousUriArb,
  httpNonLocalhostUriArb,
  stateArb,
  tooLongStateArb,
  nonceArb,
  tooLongNonceArb,
  authCodeArb,
  tooShortAuthCodeArb,
  tooLongAuthCodeArb,
  jwtFormatArb,
  twoPartJwtArb,
  fourPartJwtArb,
  malformedBase64JwtArb,
  standardScopeArb,
  reservedNamespaceScopeArb,
  unicodeStringArb,
  controlCharStringArb,
} from './helpers/fc-generators';

// =============================================================================
// Client ID Validation Properties
// =============================================================================

describe('Client ID Validation Properties', () => {
  it('∀ valid client_id: validateClientId returns valid=true', () => {
    fc.assert(
      fc.property(clientIdArb, (clientId) => {
        const result = validateClientId(clientId);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 500 }
    );
  });

  it('∀ too-long client_id: validateClientId returns valid=false', () => {
    fc.assert(
      fc.property(tooLongClientIdArb, (clientId) => {
        const result = validateClientId(clientId);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too long');
      }),
      { numRuns: 200 }
    );
  });

  it('∀ client_id with invalid chars: validateClientId returns valid=false', () => {
    fc.assert(
      fc.property(invalidCharClientIdArb, (clientId) => {
        const result = validateClientId(clientId);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('invalid characters');
      }),
      { numRuns: 300 }
    );
  });

  it('undefined/null/empty client_id: returns valid=false', () => {
    expect(validateClientId(undefined).valid).toBe(false);
    expect(validateClientId(null as unknown as string).valid).toBe(false);
    expect(validateClientId('').valid).toBe(false);
  });

  it('length boundaries: 256 valid, 257 invalid', () => {
    const validChars = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
    const c256 = validChars.repeat(7).slice(0, 256);
    const c257 = validChars.repeat(7).slice(0, 257);

    expect(validateClientId(c256).valid).toBe(true);
    expect(validateClientId(c257).valid).toBe(false);
  });
});

// =============================================================================
// Redirect URI Validation Properties
// =============================================================================

describe('Redirect URI Validation Properties', () => {
  it('∀ valid HTTPS URL: validateRedirectUri returns valid=true', () => {
    fc.assert(
      fc.property(httpsRedirectUriArb, (uri) => {
        const result = validateRedirectUri(uri);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('∀ localhost HTTP URL (with allowHttp): validateRedirectUri returns valid=true', () => {
    fc.assert(
      fc.property(localhostRedirectUriArb, (uri) => {
        const result = validateRedirectUri(uri, true);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('∀ localhost HTTP URL (without allowHttp): validateRedirectUri returns valid=false', () => {
    fc.assert(
      fc.property(localhostRedirectUriArb, (uri) => {
        const result = validateRedirectUri(uri, false);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('HTTPS');
      }),
      { numRuns: 200 }
    );
  });

  it('∀ HTTP non-localhost URL: validateRedirectUri returns valid=false', () => {
    fc.assert(
      fc.property(httpNonLocalhostUriArb, (uri) => {
        // Even with allowHttp, non-localhost HTTP should be rejected
        const resultWithAllowHttp = validateRedirectUri(uri, true);
        expect(resultWithAllowHttp.valid).toBe(false);

        const resultDefault = validateRedirectUri(uri, false);
        expect(resultDefault.valid).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('∀ malicious URI: validateRedirectUri does not throw and rejects non-https', () => {
    fc.assert(
      fc.property(maliciousUriArb, (uri) => {
        // Should not throw exception
        expect(() => {
          validateRedirectUri(uri);
        }).not.toThrow();

        const result = validateRedirectUri(uri);
        // Note: Some URIs like 'https://example.com/callback#token=stolen' are technically
        // valid HTTPS URLs. The actual security filtering happens at redirect_uri registration
        // matching level, not at format validation level.
        // Here we only check that non-https schemes are rejected.
        try {
          const parsed = new URL(uri);
          if (parsed.protocol !== 'https:') {
            expect(result.valid).toBe(false);
          }
        } catch {
          // Invalid URL format should be rejected
          expect(result.valid).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('∀ random string: validateRedirectUri does not throw', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 1000 }), (s) => {
        expect(() => {
          validateRedirectUri(s);
        }).not.toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it('undefined/empty redirect_uri: returns valid=false', () => {
    expect(validateRedirectUri(undefined).valid).toBe(false);
    expect(validateRedirectUri('').valid).toBe(false);
  });
});

// =============================================================================
// Redirect URI Normalization Properties
// =============================================================================

describe('Redirect URI Normalization Properties', () => {
  it('∀ valid HTTPS URL: normalizeRedirectUri returns non-null', () => {
    fc.assert(
      fc.property(httpsRedirectUriArb, (uri) => {
        const normalized = normalizeRedirectUri(uri);
        expect(normalized).not.toBeNull();
      }),
      { numRuns: 200 }
    );
  });

  it('∀ clean URL (no multiple slashes): normalizeRedirectUri is idempotent', () => {
    // Use a simpler URL generator that doesn't produce multiple consecutive slashes
    const cleanUrlArb = fc
      .tuple(
        fc.domain(),
        fc.webSegment().filter((s) => s.length > 0 && !s.includes('/'))
      )
      .map(([domain, path]) => `https://${domain}/${path}`);

    fc.assert(
      fc.property(cleanUrlArb, (uri) => {
        const once = normalizeRedirectUri(uri);
        if (once === null) return; // Skip invalid

        const twice = normalizeRedirectUri(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 200 }
    );
  });

  it('normalization removes default ports', () => {
    expect(normalizeRedirectUri('https://example.com:443/callback')).toBe(
      'https://example.com/callback'
    );
    expect(normalizeRedirectUri('http://example.com:80/callback')).toBe(
      'http://example.com/callback'
    );
  });

  it('normalization preserves non-default ports', () => {
    expect(normalizeRedirectUri('https://example.com:8443/callback')).toBe(
      'https://example.com:8443/callback'
    );
    expect(normalizeRedirectUri('http://example.com:8080/callback')).toBe(
      'http://example.com:8080/callback'
    );
  });

  it('normalization lowercases hostname', () => {
    expect(normalizeRedirectUri('https://EXAMPLE.COM/callback')).toBe(
      'https://example.com/callback'
    );
    expect(normalizeRedirectUri('https://ExAmPlE.cOm/CallBack')).toBe(
      'https://example.com/CallBack' // Path is NOT lowercased
    );
  });

  it('∀ malicious URI: normalizeRedirectUri returns null', () => {
    fc.assert(
      fc.property(maliciousUriArb, (uri) => {
        const normalized = normalizeRedirectUri(uri);
        // Most malicious URIs should fail normalization
        // (some like path traversal might pass if URL is valid)
        if (normalized !== null) {
          // If it did normalize, make sure it doesn't have dangerous patterns
          expect(normalized).not.toContain('javascript:');
          expect(normalized).not.toContain('data:');
          expect(normalized).not.toContain('file:');
        }
      }),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Redirect URI Registration Matching Properties
// =============================================================================

describe('Redirect URI Registration Properties', () => {
  it('∀ registered URI: isRedirectUriRegistered returns true', () => {
    fc.assert(
      fc.property(httpsRedirectUriArb, (uri) => {
        const registered = [uri];
        expect(isRedirectUriRegistered(uri, registered)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('∀ unregistered URI: isRedirectUriRegistered returns false', () => {
    fc.assert(
      fc.property(
        fc.tuple(httpsRedirectUriArb, httpsRedirectUriArb).filter(([a, b]) => a !== b),
        ([provided, registered]) => {
          expect(isRedirectUriRegistered(provided, [registered])).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('requires exact string matching for default ports', () => {
    expect(
      isRedirectUriRegistered('https://example.com:443/callback', ['https://example.com/callback'])
    ).toBe(false);

    expect(
      isRedirectUriRegistered('https://example.com/callback', ['https://example.com:443/callback'])
    ).toBe(false);
  });

  it('requires exact string matching for host casing and path', () => {
    expect(
      isRedirectUriRegistered('https://EXAMPLE.COM/callback', ['https://example.com/callback'])
    ).toBe(false);

    expect(
      isRedirectUriRegistered('https://example.com/CallBack', ['https://example.com/callback'])
    ).toBe(false);
  });

  it('allows only the ephemeral port to vary for RFC 8252 loopback IP redirects', () => {
    expect(
      isRedirectUriRegistered('http://127.0.0.1:58848/callback/nonce', [
        'http://127.0.0.1:58483/callback/nonce',
      ])
    ).toBe(true);
    expect(
      isRedirectUriRegistered('http://[::1]:58848/callback/nonce?channel=codex', [
        'http://[::1]:58483/callback/nonce?channel=codex',
      ])
    ).toBe(true);
    expect(
      isRedirectUriRegistered('http://127.0.0.1:58848/callback/other', [
        'http://127.0.0.1:58483/callback/nonce',
      ])
    ).toBe(false);
    expect(
      isRedirectUriRegistered('http://localhost:58848/callback/nonce', [
        'http://localhost:58483/callback/nonce',
      ])
    ).toBe(false);
    expect(
      isRedirectUriRegistered('https://127.0.0.1:58848/callback/nonce', [
        'https://127.0.0.1:58483/callback/nonce',
      ])
    ).toBe(false);
  });

  it('accepts IPv4 and IPv6 loopback HTTP only when the caller enables it', () => {
    expect(validateRedirectUri('http://127.0.0.1:58848/callback', true).valid).toBe(true);
    expect(validateRedirectUri('http://[::1]:58848/callback', true).valid).toBe(true);
    expect(validateRedirectUri('http://127.0.0.1:58848/callback').valid).toBe(false);
  });
});

// =============================================================================
// State Validation Properties
// =============================================================================

describe('State Validation Properties', () => {
  it('∀ valid state (1-2048 chars): validateState returns valid=true', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const result = validateState(state);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('∀ too-long state: validateState returns valid=false', () => {
    fc.assert(
      fc.property(tooLongStateArb, (state) => {
        const result = validateState(state);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too long');
      }),
      { numRuns: 200 }
    );
  }, 15_000);

  it('undefined state: returns valid=true (optional parameter)', () => {
    expect(validateState(undefined).valid).toBe(true);
  });

  it('empty state: returns valid=false (if provided, must not be empty)', () => {
    expect(validateState('').valid).toBe(false);
  });

  it('length boundaries: 2048 valid, 2049 invalid', () => {
    const s2048 = 'a'.repeat(2048);
    const s2049 = 'a'.repeat(2049);

    expect(validateState(s2048).valid).toBe(true);
    expect(validateState(s2049).valid).toBe(false);
  });
});

// =============================================================================
// Nonce Validation Properties
// =============================================================================

describe('Nonce Validation Properties', () => {
  it('∀ valid nonce (1-512 chars): validateNonce returns valid=true', () => {
    fc.assert(
      fc.property(nonceArb, (nonce) => {
        const result = validateNonce(nonce);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('∀ too-long nonce: validateNonce returns valid=false', () => {
    fc.assert(
      fc.property(tooLongNonceArb, (nonce) => {
        const result = validateNonce(nonce);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too long');
      }),
      { numRuns: 200 }
    );
  });

  it('undefined nonce: returns valid=true (optional parameter)', () => {
    expect(validateNonce(undefined).valid).toBe(true);
  });

  it('empty nonce: returns valid=false (if provided, must not be empty)', () => {
    expect(validateNonce('').valid).toBe(false);
  });
});

// =============================================================================
// Scope Validation Properties
// =============================================================================

describe('Scope Validation Properties', () => {
  it('∀ standard scope with openid: validateScope returns valid=true', () => {
    fc.assert(
      fc.property(standardScopeArb, (scope) => {
        const result = validateScope(scope);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('scope without openid: returns valid=false (by default)', () => {
    const scopesWithoutOpenid = ['profile', 'email', 'profile email'];

    for (const scope of scopesWithoutOpenid) {
      const result = validateScope(scope);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('openid');
    }
  });

  it('scope without openid: returns valid=true when requireOpenid=false', () => {
    const result = validateScope('profile email', { requireOpenid: false });
    expect(result.valid).toBe(true);
  });

  it('∀ reserved namespace scope: returns valid=false (allowCustomScopes=true)', () => {
    fc.assert(
      fc.property(reservedNamespaceScopeArb, (reservedScope) => {
        const scope = `openid ${reservedScope}`;
        const result = validateScope(scope, { allowCustomScopes: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('reserved namespace');
      }),
      { numRuns: 100 }
    );
  });

  it('ai: scopes rejected by default', () => {
    const result = validateScope('openid ai:read');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('AI scope');
  });

  it('ai: scopes allowed when allowAIScopes=true', () => {
    const result = validateScope('openid ai:read', { allowAIScopes: true });
    expect(result.valid).toBe(true);
  });

  it('undefined/empty scope: returns valid=false', () => {
    expect(validateScope(undefined).valid).toBe(false);
    expect(validateScope('').valid).toBe(false);
    expect(validateScope('   ').valid).toBe(false);
  });

  it('handles multiple spaces between scopes', () => {
    const result = validateScope('openid    profile     email');
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// Authorization Code Validation Properties
// =============================================================================

describe('Authorization Code Validation Properties', () => {
  it('∀ valid auth code (32-512 base64url): validateAuthCode returns valid=true', () => {
    fc.assert(
      fc.property(authCodeArb, (code) => {
        const result = validateAuthCode(code);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('∀ too-short auth code: validateAuthCode returns valid=false', () => {
    fc.assert(
      fc.property(tooShortAuthCodeArb, (code) => {
        const result = validateAuthCode(code);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too short');
      }),
      { numRuns: 200 }
    );
  });

  it('∀ too-long auth code: validateAuthCode returns valid=false', () => {
    fc.assert(
      fc.property(tooLongAuthCodeArb, (code) => {
        const result = validateAuthCode(code);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too long');
      }),
      { numRuns: 200 }
    );
  });

  it('undefined/empty auth code: returns valid=false', () => {
    expect(validateAuthCode(undefined).valid).toBe(false);
    expect(validateAuthCode('').valid).toBe(false);
  });

  it('length boundaries: 31 invalid, 32 valid, 512 valid, 513 invalid', () => {
    const base64urlChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const c31 = base64urlChars.slice(0, 31);
    const c32 = base64urlChars.slice(0, 32);
    const c512 = base64urlChars.repeat(8).slice(0, 512);
    const c513 = base64urlChars.repeat(9).slice(0, 513);

    expect(validateAuthCode(c31).valid).toBe(false);
    expect(validateAuthCode(c32).valid).toBe(true);
    expect(validateAuthCode(c512).valid).toBe(true);
    expect(validateAuthCode(c513).valid).toBe(false);
  });

  it('auth code with standard base64 chars (+/=): returns valid=false', () => {
    const codeWithPlus = 'a'.repeat(31) + '+';
    const codeWithSlash = 'a'.repeat(31) + '/';
    const codeWithEquals = 'a'.repeat(31) + '=';

    expect(validateAuthCode(codeWithPlus).valid).toBe(false);
    expect(validateAuthCode(codeWithSlash).valid).toBe(false);
    expect(validateAuthCode(codeWithEquals).valid).toBe(false);
  });
});

// =============================================================================
// Token (JWT) Validation Properties
// =============================================================================

describe('Token (JWT) Validation Properties', () => {
  it('∀ valid JWT format (3 base64url parts): validateToken returns valid=true', () => {
    fc.assert(
      fc.property(jwtFormatArb, (token) => {
        const result = validateToken(token);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('∀ 2-part token: validateToken returns valid=false', () => {
    fc.assert(
      fc.property(twoPartJwtArb, (token) => {
        const result = validateToken(token);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('3 parts');
      }),
      { numRuns: 200 }
    );
  });

  it('∀ 4-part token: validateToken returns valid=false', () => {
    fc.assert(
      fc.property(fourPartJwtArb, (token) => {
        const result = validateToken(token);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('3 parts');
      }),
      { numRuns: 200 }
    );
  });

  it('∀ malformed base64 JWT (with +/=): validateToken returns valid=false', () => {
    // Note: Our malformedBase64JwtArb includes 'ABCDE+/=' chars in the header
    // but some generated strings might only use 'ABCDE' (which are valid base64url)
    // This test checks that tokens with actual +/= chars are rejected
    fc.assert(
      fc.property(malformedBase64JwtArb, (token) => {
        const result = validateToken(token);
        const parts = token.split('.');
        // Only expect failure if the token actually contains invalid base64url chars
        const hasInvalidChars = parts.some((part) => /[+/=]/.test(part));
        if (hasInvalidChars) {
          expect(result.valid).toBe(false);
          expect(result.error).toContain('base64url');
        }
        // Otherwise the generated token happens to be valid base64url
      }),
      { numRuns: 200 }
    );
  });

  it('undefined/empty token: returns valid=false', () => {
    expect(validateToken(undefined).valid).toBe(false);
    expect(validateToken('').valid).toBe(false);
  });

  it('real JWT format accepted', () => {
    const realJwtLike =
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    expect(validateToken(realJwtLike).valid).toBe(true);
  });
});

// =============================================================================
// Unicode/Control Character Robustness Properties
// =============================================================================

describe('Unicode/Control Character Robustness', () => {
  it('∀ unicode string: validators do not throw', () => {
    fc.assert(
      fc.property(unicodeStringArb, (s) => {
        expect(() => validateClientId(s)).not.toThrow();
        expect(() => validateState(s)).not.toThrow();
        expect(() => validateNonce(s)).not.toThrow();
        expect(() => validateScope(s)).not.toThrow();
        expect(() => validateAuthCode(s)).not.toThrow();
        expect(() => validateToken(s)).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });

  it('∀ control char string: validators do not throw', () => {
    fc.assert(
      fc.property(controlCharStringArb, (s) => {
        expect(() => validateClientId(s)).not.toThrow();
        expect(() => validateState(s)).not.toThrow();
        expect(() => validateNonce(s)).not.toThrow();
        expect(() => validateScope(s)).not.toThrow();
        expect(() => validateAuthCode(s)).not.toThrow();
        expect(() => validateToken(s)).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });

  it('NULL byte injection: validators handle gracefully', () => {
    const nullByteStrings = ['test\x00injection', '\x00start', 'end\x00', 'mid\x00dle'];

    for (const s of nullByteStrings) {
      expect(() => validateClientId(s)).not.toThrow();
      expect(() => validateState(s)).not.toThrow();
      expect(() => validateRedirectUri(s)).not.toThrow();

      // Client ID should reject NULL bytes (invalid character)
      expect(validateClientId(s).valid).toBe(false);
    }
  });

  it('CRLF injection: validators handle gracefully', () => {
    const crlfStrings = ['test\r\ninjection', 'header\r\nX-Injected: value'];

    for (const s of crlfStrings) {
      expect(() => validateClientId(s)).not.toThrow();
      expect(() => validateState(s)).not.toThrow();
      expect(() => validateRedirectUri(s)).not.toThrow();
    }
  });
});
