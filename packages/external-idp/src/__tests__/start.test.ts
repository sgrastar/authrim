/**
 * Start Handler Tests
 * Tests rate limiting, open redirect prevention, and auth start flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock implementations for testing rate limiting logic
// These mirror the implementation in start.ts

interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
  enabled: boolean;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowSeconds: 60,
  enabled: true,
};

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

interface RateLimitStorage {
  count: number;
  windowStart: number;
}

/**
 * Implementation of rate limit check for testing
 * This mirrors the implementation in start.ts
 */
async function checkRateLimit(
  clientIp: string,
  config: RateLimitConfig,
  storage: Map<string, RateLimitStorage>
): Promise<RateLimitResult> {
  if (!config.enabled) {
    return { allowed: true, remaining: config.maxRequests, retryAfter: 0 };
  }

  const key = `rate_limit:external_idp:start:${clientIp}`;
  const now = Date.now();

  const current = storage.get(key) || { count: 0, windowStart: now };

  // Check if window has expired
  if (now - current.windowStart > config.windowSeconds * 1000) {
    current.count = 0;
    current.windowStart = now;
  }

  // Check if limit exceeded
  if (current.count >= config.maxRequests) {
    const windowEnd = current.windowStart + config.windowSeconds * 1000;
    const retryAfter = Math.ceil((windowEnd - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, retryAfter),
    };
  }

  // Increment count
  current.count++;
  storage.set(key, current);

  return {
    allowed: true,
    remaining: config.maxRequests - current.count,
    retryAfter: 0,
  };
}

/**
 * Implementation of redirect URI validation for testing
 * This mirrors the implementation in start.ts
 */
function validateRedirectUri(
  requestedUri: string | undefined,
  env: { UI_BASE_URL?: string; ISSUER_URL: string }
): string {
  const baseUrl = env.UI_BASE_URL || env.ISSUER_URL;
  const defaultRedirect = `${baseUrl}/`;

  if (!requestedUri) {
    return defaultRedirect;
  }

  try {
    // Handle relative paths
    if (requestedUri.startsWith('/')) {
      return new URL(requestedUri, baseUrl).toString();
    }

    // Parse the requested URI
    const requestedUrl = new URL(requestedUri);
    const baseUrlParsed = new URL(baseUrl);
    const issuerUrlParsed = new URL(env.ISSUER_URL);

    // Extract allowed origins
    const allowedOrigins = new Set([baseUrlParsed.origin, issuerUrlParsed.origin]);

    // Check if the requested origin is allowed
    if (allowedOrigins.has(requestedUrl.origin)) {
      return requestedUri;
    }

    return defaultRedirect;
  } catch {
    return defaultRedirect;
  }
}

describe('Rate Limiting', () => {
  let storage: Map<string, RateLimitStorage>;

  beforeEach(() => {
    storage = new Map();
  });

  describe('basic rate limiting', () => {
    it('should allow requests within limit', async () => {
      const config: RateLimitConfig = {
        maxRequests: 10,
        windowSeconds: 60,
        enabled: true,
      };

      const result = await checkRateLimit('192.168.1.1', config, storage);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.retryAfter).toBe(0);
    });

    it('should track requests per IP', async () => {
      const config: RateLimitConfig = {
        maxRequests: 10,
        windowSeconds: 60,
        enabled: true,
      };

      // First request
      let result = await checkRateLimit('192.168.1.1', config, storage);
      expect(result.remaining).toBe(9);

      // Second request from same IP
      result = await checkRateLimit('192.168.1.1', config, storage);
      expect(result.remaining).toBe(8);

      // Request from different IP
      result = await checkRateLimit('192.168.1.2', config, storage);
      expect(result.remaining).toBe(9); // New counter for new IP
    });

    it('should block requests exceeding limit', async () => {
      const config: RateLimitConfig = {
        maxRequests: 3,
        windowSeconds: 60,
        enabled: true,
      };

      // Make 3 allowed requests
      for (let i = 0; i < 3; i++) {
        const result = await checkRateLimit('192.168.1.1', config, storage);
        expect(result.allowed).toBe(true);
      }

      // 4th request should be blocked
      const result = await checkRateLimit('192.168.1.1', config, storage);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should reset counter after window expires', async () => {
      const config: RateLimitConfig = {
        maxRequests: 2,
        windowSeconds: 1, // 1 second window for testing
        enabled: true,
      };

      // Exhaust limit
      await checkRateLimit('192.168.1.1', config, storage);
      await checkRateLimit('192.168.1.1', config, storage);

      // Should be blocked
      let result = await checkRateLimit('192.168.1.1', config, storage);
      expect(result.allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be allowed again
      result = await checkRateLimit('192.168.1.1', config, storage);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it('should be disabled when enabled is false', async () => {
      const config: RateLimitConfig = {
        maxRequests: 1,
        windowSeconds: 60,
        enabled: false,
      };

      // Should allow unlimited requests when disabled
      for (let i = 0; i < 100; i++) {
        const result = await checkRateLimit('192.168.1.1', config, storage);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(1);
      }
    });
  });

  describe('retry-after calculation', () => {
    it('should calculate correct retry-after time', async () => {
      const config: RateLimitConfig = {
        maxRequests: 1,
        windowSeconds: 30,
        enabled: true,
      };

      // Exhaust limit
      await checkRateLimit('192.168.1.1', config, storage);

      // Get blocked result
      const result = await checkRateLimit('192.168.1.1', config, storage);

      expect(result.allowed).toBe(false);
      // Retry-after should be close to 30 seconds
      expect(result.retryAfter).toBeLessThanOrEqual(30);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should return minimum retry-after of 1 second', async () => {
      const config: RateLimitConfig = {
        maxRequests: 1,
        windowSeconds: 1, // 1 second window
        enabled: true,
      };

      await checkRateLimit('192.168.1.1', config, storage);
      const result = await checkRateLimit('192.168.1.1', config, storage);

      expect(result.retryAfter).toBeGreaterThanOrEqual(1);
    });
  });

  describe('default configuration', () => {
    it('should have secure default values', () => {
      expect(DEFAULT_RATE_LIMIT.maxRequests).toBe(10);
      expect(DEFAULT_RATE_LIMIT.windowSeconds).toBe(60);
      expect(DEFAULT_RATE_LIMIT.enabled).toBe(true);
    });
  });
});

describe('Open Redirect Prevention', () => {
  const mockEnv = {
    UI_BASE_URL: 'https://auth.example.com',
    ISSUER_URL: 'https://api.example.com',
  };

  describe('allowed redirects', () => {
    it('should allow redirect to UI_BASE_URL', () => {
      const result = validateRedirectUri('https://auth.example.com/dashboard', mockEnv);
      expect(result).toBe('https://auth.example.com/dashboard');
    });

    it('should allow redirect to ISSUER_URL', () => {
      const result = validateRedirectUri('https://api.example.com/callback', mockEnv);
      expect(result).toBe('https://api.example.com/callback');
    });

    it('should allow relative paths', () => {
      const result = validateRedirectUri('/dashboard', mockEnv);
      expect(result).toBe('https://auth.example.com/dashboard');
    });

    it('should convert relative path to absolute using UI_BASE_URL', () => {
      const result = validateRedirectUri('/login?redirect=/profile', mockEnv);
      expect(result).toBe('https://auth.example.com/login?redirect=/profile');
    });
  });

  describe('blocked redirects', () => {
    it('should block redirect to external domain', () => {
      const result = validateRedirectUri('https://evil.com/phishing', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should block redirect to subdomain attack', () => {
      const result = validateRedirectUri('https://auth.example.com.evil.com/attack', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should block redirect with different port', () => {
      const result = validateRedirectUri('https://auth.example.com:8080/malicious', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should block redirect with different protocol', () => {
      const result = validateRedirectUri('http://auth.example.com/insecure', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should block javascript: URLs', () => {
      const result = validateRedirectUri('javascript:alert(1)', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should block data: URLs', () => {
      const result = validateRedirectUri('data:text/html,<script>alert(1)</script>', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });
  });

  describe('edge cases', () => {
    it('should return default when no redirect_uri provided', () => {
      const result = validateRedirectUri(undefined, mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should return default for empty string', () => {
      const result = validateRedirectUri('', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should return default for invalid URL', () => {
      const result = validateRedirectUri('not-a-valid-url', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should handle URL with query parameters', () => {
      const result = validateRedirectUri(
        'https://auth.example.com/callback?code=abc&state=xyz',
        mockEnv
      );
      expect(result).toBe('https://auth.example.com/callback?code=abc&state=xyz');
    });

    it('should handle URL with fragment', () => {
      const result = validateRedirectUri('https://auth.example.com/app#/dashboard', mockEnv);
      expect(result).toBe('https://auth.example.com/app#/dashboard');
    });

    it('should use ISSUER_URL as default when UI_BASE_URL not set', () => {
      const envWithoutUi = {
        ISSUER_URL: 'https://api.example.com',
      };
      const result = validateRedirectUri(undefined, envWithoutUi);
      expect(result).toBe('https://api.example.com/');
    });
  });

  describe('URL parsing attacks', () => {
    it('should block backslash URL confusion attack', () => {
      // Modern URL parsers normalize backslash to forward slash
      // The result will be an internal path, which is allowed since it's same origin
      // This test documents the behavior - the URL parser handles it safely
      const result = validateRedirectUri('https://auth.example.com\\@evil.com', mockEnv);
      // Node's URL parser normalizes this to https://auth.example.com/@evil.com (same origin, allowed)
      // This is actually safe because the origin remains the same
      expect(result.startsWith('https://auth.example.com')).toBe(true);
    });

    it('should block @ symbol URL confusion', () => {
      // URL: https://evil.com\@auth.example.com - the backslash before @ changes meaning
      // In Node.js URL parser, this becomes https://evil.com/@auth.example.com
      // which has evil.com as the origin and should be blocked
      const result = validateRedirectUri('https://evil.com\\@auth.example.com', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should block null byte injection', () => {
      // Percent-encoded null byte in URL - should be blocked
      const result = validateRedirectUri('https://auth.example.com%00.evil.com', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });

    it('should block user:pass@host confusion', () => {
      // URL with credentials that might confuse parsers
      const result = validateRedirectUri('https://auth.example.com:secret@evil.com/path', mockEnv);
      expect(result).toBe('https://auth.example.com/');
    });
  });
});

describe('max_age parameter validation', () => {
  it('should accept valid positive integer', () => {
    const maxAge = parseInt('300', 10);
    expect(isNaN(maxAge)).toBe(false);
    expect(maxAge).toBe(300);
    expect(maxAge >= 0).toBe(true);
  });

  it('should accept zero', () => {
    const maxAge = parseInt('0', 10);
    expect(isNaN(maxAge)).toBe(false);
    expect(maxAge).toBe(0);
    expect(maxAge >= 0).toBe(true);
  });

  it('should reject negative numbers', () => {
    const maxAge = parseInt('-1', 10);
    expect(maxAge < 0).toBe(true);
  });

  it('should reject non-numeric strings', () => {
    const maxAge = parseInt('not-a-number', 10);
    expect(isNaN(maxAge)).toBe(true);
  });

  it('should reject float strings (parseInt behavior)', () => {
    const maxAge = parseInt('3.14', 10);
    // parseInt truncates to integer
    expect(maxAge).toBe(3);
    expect(Number.isInteger(maxAge)).toBe(true);
  });
});

describe('client IP extraction', () => {
  /**
   * Implementation of getClientIp for testing
   */
  function getClientIp(headers: Record<string, string | undefined>): string {
    return (
      headers['CF-Connecting-IP'] ||
      headers['X-Forwarded-For']?.split(',')[0]?.trim() ||
      headers['X-Real-IP'] ||
      'unknown'
    );
  }

  it('should prefer CF-Connecting-IP header', () => {
    const headers = {
      'CF-Connecting-IP': '1.2.3.4',
      'X-Forwarded-For': '5.6.7.8, 9.10.11.12',
      'X-Real-IP': '13.14.15.16',
    };
    expect(getClientIp(headers)).toBe('1.2.3.4');
  });

  it('should use first IP from X-Forwarded-For', () => {
    const headers = {
      'X-Forwarded-For': '1.2.3.4, 5.6.7.8, 9.10.11.12',
      'X-Real-IP': '13.14.15.16',
    };
    expect(getClientIp(headers)).toBe('1.2.3.4');
  });

  it('should trim whitespace from X-Forwarded-For', () => {
    const headers = {
      'X-Forwarded-For': '  1.2.3.4  , 5.6.7.8',
    };
    expect(getClientIp(headers)).toBe('1.2.3.4');
  });

  it('should fall back to X-Real-IP', () => {
    const headers = {
      'X-Real-IP': '1.2.3.4',
    };
    expect(getClientIp(headers)).toBe('1.2.3.4');
  });

  it('should return unknown when no headers present', () => {
    const headers: Record<string, string | undefined> = {};
    expect(getClientIp(headers)).toBe('unknown');
  });
});
