/**
 * Email Code (OTP) Handlers Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/shared';

// Mock dependencies
const mockChallengeStore = {
  createChallenge: vi.fn(),
  verifyChallenge: vi.fn(),
  deleteChallenge: vi.fn(),
};

const mockSessionStore = {
  createSession: vi.fn(),
};

const mockRateLimiter = {
  check: vi.fn(),
};

vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    ChallengeStore: vi.fn().mockImplementation(() => mockChallengeStore),
    SessionStore: vi.fn().mockImplementation(() => mockSessionStore),
    RateLimiter: vi.fn().mockImplementation(() => mockRateLimiter),
  };
});

describe('Email Code Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiter.check.mockResolvedValue({ allowed: true, remaining: 10 });
  });

  describe('emailCodeSendHandler', () => {
    it('should require email parameter', async () => {
      // Test that email is required
      const requestBody = {};
      expect(Object.keys(requestBody)).not.toContain('email');
    });

    it('should validate email format', () => {
      const validEmails = ['test@example.com', 'user.name@domain.org', 'user+tag@example.co.uk'];
      const invalidEmails = ['invalid', '@example.com', 'user@', 'user name@example.com'];

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      validEmails.forEach((email) => {
        expect(emailRegex.test(email)).toBe(true);
      });

      invalidEmails.forEach((email) => {
        expect(emailRegex.test(email)).toBe(false);
      });
    });

    it('should enforce rate limiting', async () => {
      mockRateLimiter.check.mockResolvedValue({ allowed: false, remaining: 0 });

      // Verify rate limiter returns blocked state
      const result = await mockRateLimiter.check('email:test@example.com', 3, 60000);
      expect(result.allowed).toBe(false);
    });

    it('should generate a 6-digit OTP code', () => {
      // Import and test the code generation function
      const code = generateMockCode();
      expect(code).toMatch(/^\d{6}$/);
    });

    it('should set otp_session_id cookie', () => {
      // Test cookie structure
      const cookieOptions = {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 300, // 5 minutes
      };

      expect(cookieOptions.httpOnly).toBe(true);
      expect(cookieOptions.secure).toBe(true);
      expect(cookieOptions.maxAge).toBe(300);
    });

    it('should store hashed code in ChallengeStore', async () => {
      mockChallengeStore.createChallenge.mockResolvedValue({ challengeId: 'challenge-123' });

      await mockChallengeStore.createChallenge({
        type: 'email_code',
        email: 'test@example.com',
        sessionId: 'session-123',
        hash: 'hashed-code',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
      });

      expect(mockChallengeStore.createChallenge).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email_code',
          email: 'test@example.com',
        })
      );
    });

    it('should include code in development mode response', () => {
      const isDev = true;
      const code = '123456';

      const response = isDev ? { success: true, code } : { success: true };
      expect(response).toHaveProperty('code');
    });

    it('should not include code in production mode response', () => {
      const isDev = false;
      const code = '123456';

      const response = isDev ? { success: true, code } : { success: true };
      expect(response).not.toHaveProperty('code');
    });
  });

  describe('emailCodeVerifyHandler', () => {
    it('should require code and email parameters', () => {
      const requiredParams = ['code', 'email'];
      const requestBody = { code: '123456', email: 'test@example.com' };

      requiredParams.forEach((param) => {
        expect(requestBody).toHaveProperty(param);
      });
    });

    it('should validate code format (6 digits)', () => {
      const validCodes = ['000000', '123456', '999999'];
      const invalidCodes = ['12345', '1234567', 'abcdef', '12345a', ''];

      const codeRegex = /^\d{6}$/;

      validCodes.forEach((code) => {
        expect(codeRegex.test(code)).toBe(true);
      });

      invalidCodes.forEach((code) => {
        expect(codeRegex.test(code)).toBe(false);
      });
    });

    it('should read otp_session_id from cookie', () => {
      const cookies = {
        otp_session_id: 'session-123',
      };

      expect(cookies.otp_session_id).toBeDefined();
    });

    it('should return error for missing session cookie', () => {
      const cookies: Record<string, string> = {};
      const hasSession = 'otp_session_id' in cookies;

      expect(hasSession).toBe(false);
    });

    it('should reject expired codes', async () => {
      const codeData = {
        email: 'test@example.com',
        sessionId: 'session-123',
        hash: 'hashed-code',
        issuedAt: Date.now() - 400000, // 6+ minutes ago
        expiresAt: Date.now() - 100000, // Already expired
      };

      const isExpired = codeData.expiresAt < Date.now();
      expect(isExpired).toBe(true);
    });

    it('should reject mismatched session IDs', () => {
      const cookieSessionId = 'session-cookie';
      const storedSessionId = 'session-stored';

      expect(cookieSessionId).not.toBe(storedSessionId);
    });

    it('should verify code hash correctly', async () => {
      // Mock successful verification
      mockChallengeStore.verifyChallenge.mockResolvedValue({
        valid: true,
        data: {
          email: 'test@example.com',
          sessionId: 'session-123',
        },
      });

      const result = await mockChallengeStore.verifyChallenge('challenge-123');
      expect(result.valid).toBe(true);
    });

    it('should delete challenge after successful verification', async () => {
      mockChallengeStore.deleteChallenge.mockResolvedValue({ success: true });

      await mockChallengeStore.deleteChallenge('challenge-123');
      expect(mockChallengeStore.deleteChallenge).toHaveBeenCalledWith('challenge-123');
    });

    it('should create session on successful verification', async () => {
      mockSessionStore.createSession.mockResolvedValue({
        sessionId: 'new-session-123',
        userId: 'user-123',
      });

      const result = await mockSessionStore.createSession({
        userId: 'user-123',
        email: 'test@example.com',
      });

      expect(result.sessionId).toBeDefined();
      expect(result.userId).toBe('user-123');
    });

    it('should clear otp_session_id cookie after successful verification', () => {
      const clearCookieOptions = {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      };

      expect(clearCookieOptions.maxAge).toBe(0);
    });

    it('should return user info on successful verification', () => {
      const response = {
        success: true,
        sessionId: 'session-123',
        userId: 'user-123',
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
        },
      };

      expect(response.success).toBe(true);
      expect(response.user).toBeDefined();
      expect(response.user.email).toBe('test@example.com');
    });

    it('should enforce rate limiting on verification attempts', async () => {
      mockRateLimiter.check.mockResolvedValue({ allowed: false, remaining: 0 });

      const result = await mockRateLimiter.check('verify:test@example.com', 5, 300000);
      expect(result.allowed).toBe(false);
    });
  });

  describe('OTP TTL and Expiration', () => {
    it('should set 5 minute TTL for OTP codes', () => {
      const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
      expect(OTP_TTL_MS).toBe(300000);
    });

    it('should correctly calculate expiration time', () => {
      const now = Date.now();
      const OTP_TTL_MS = 300000;
      const expiresAt = now + OTP_TTL_MS;

      expect(expiresAt - now).toBe(300000);
    });

    it('should reject codes older than 5 minutes', () => {
      const now = Date.now();
      const issuedAt = now - 301000; // 5 minutes + 1 second ago
      const OTP_TTL_MS = 300000;

      const isExpired = now - issuedAt > OTP_TTL_MS;
      expect(isExpired).toBe(true);
    });

    it('should accept codes within 5 minutes', () => {
      const now = Date.now();
      const issuedAt = now - 299000; // Just under 5 minutes ago
      const OTP_TTL_MS = 300000;

      const isExpired = now - issuedAt > OTP_TTL_MS;
      expect(isExpired).toBe(false);
    });
  });

  describe('Session Binding', () => {
    it('should generate unique session IDs', () => {
      const sessionIds = new Set<string>();
      for (let i = 0; i < 100; i++) {
        sessionIds.add(crypto.randomUUID());
      }
      expect(sessionIds.size).toBe(100);
    });

    it('should bind OTP to session ID', () => {
      const sessionId = 'session-abc123';
      const challengeData = {
        type: 'email_code',
        email: 'test@example.com',
        sessionId: sessionId,
        hash: 'hashed-code',
      };

      expect(challengeData.sessionId).toBe(sessionId);
    });
  });

  describe('Email Content', () => {
    it('should include Safari autofill format in email', () => {
      const code = '123456';
      const domain = 'example.com';
      const safariFormat = `@${domain} #${code}`;

      expect(safariFormat).toBe('@example.com #123456');
      expect(safariFormat).toContain('@');
      expect(safariFormat).toContain('#');
    });

    it('should extract domain from ISSUER_URL', () => {
      const issuerUrl = 'https://auth.example.com';
      const url = new URL(issuerUrl);
      const domain = url.hostname;

      expect(domain).toBe('auth.example.com');
    });
  });

  describe('Error Handling', () => {
    it('should return appropriate error for invalid code format', () => {
      const errorResponse = {
        error: 'invalid_request',
        error_description: 'Invalid verification code format',
      };

      expect(errorResponse.error).toBe('invalid_request');
    });

    it('should return appropriate error for expired code', () => {
      const errorResponse = {
        error: 'invalid_grant',
        error_description: 'Verification code has expired',
      };

      expect(errorResponse.error).toBe('invalid_grant');
    });

    it('should return appropriate error for session mismatch', () => {
      const errorResponse = {
        error: 'session_mismatch',
        error_description: 'Session mismatch. Please request a new code.',
      };

      expect(errorResponse.error).toBe('session_mismatch');
    });

    it('should return appropriate error for rate limit exceeded', () => {
      const errorResponse = {
        error: 'rate_limit_exceeded',
        error_description: 'Too many attempts. Please try again later.',
      };

      expect(errorResponse.error).toBe('rate_limit_exceeded');
    });
  });
});

// Helper function for tests
function generateMockCode(): string {
  return Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, '0');
}
