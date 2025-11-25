import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateSessionState,
  parseSessionState,
  validateSessionState,
  extractOrigin,
  generateCheckSessionIframeHtml,
} from '../session-state';

describe('OIDC Session State Utilities', () => {
  // Mock crypto.getRandomValues for deterministic tests
  const mockRandomValues = vi.fn();
  const originalGetRandomValues = global.crypto.getRandomValues;

  beforeEach(() => {
    // Use deterministic random values for testing
    mockRandomValues.mockImplementation((array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) {
        array[i] = i % 256;
      }
      return array;
    });
    // @ts-ignore
    global.crypto.getRandomValues = mockRandomValues;
  });

  afterEach(() => {
    global.crypto.getRandomValues = originalGetRandomValues;
    mockRandomValues.mockReset();
  });

  describe('calculateSessionState', () => {
    it('should calculate session state with auto-generated salt', async () => {
      const clientId = 'test-client';
      const origin = 'https://rp.example.com';
      const opBrowserState = 'session-123';

      const sessionState = await calculateSessionState(clientId, origin, opBrowserState);

      expect(sessionState).toBeDefined();
      expect(typeof sessionState).toBe('string');
      expect(sessionState).toContain('.');
    });

    it('should calculate session state with provided salt', async () => {
      const clientId = 'test-client';
      const origin = 'https://rp.example.com';
      const opBrowserState = 'session-123';
      const salt = 'fixed-salt';

      const sessionState = await calculateSessionState(clientId, origin, opBrowserState, salt);

      expect(sessionState).toBeDefined();
      expect(sessionState).toContain('.');
      expect(sessionState.endsWith(`.${salt}`)).toBe(true);
    });

    it('should produce different results for different inputs', async () => {
      const sessionState1 = await calculateSessionState(
        'client1',
        'https://rp1.com',
        'session1',
        'salt1'
      );
      const sessionState2 = await calculateSessionState(
        'client2',
        'https://rp1.com',
        'session1',
        'salt1'
      );
      const sessionState3 = await calculateSessionState(
        'client1',
        'https://rp2.com',
        'session1',
        'salt1'
      );
      const sessionState4 = await calculateSessionState(
        'client1',
        'https://rp1.com',
        'session2',
        'salt1'
      );

      expect(sessionState1).not.toBe(sessionState2);
      expect(sessionState1).not.toBe(sessionState3);
      expect(sessionState1).not.toBe(sessionState4);
    });

    it('should produce same result for same inputs', async () => {
      const params = {
        clientId: 'test-client',
        origin: 'https://rp.example.com',
        opBrowserState: 'session-123',
        salt: 'fixed-salt',
      };

      const sessionState1 = await calculateSessionState(
        params.clientId,
        params.origin,
        params.opBrowserState,
        params.salt
      );
      const sessionState2 = await calculateSessionState(
        params.clientId,
        params.origin,
        params.opBrowserState,
        params.salt
      );

      expect(sessionState1).toBe(sessionState2);
    });
  });

  describe('parseSessionState', () => {
    it('should parse valid session state', () => {
      const sessionState = 'abc123hash.mysalt';
      const parsed = parseSessionState(sessionState);

      expect(parsed).not.toBeNull();
      expect(parsed?.hash).toBe('abc123hash');
      expect(parsed?.salt).toBe('mysalt');
    });

    it('should handle session state with multiple dots', () => {
      const sessionState = 'hash.with.dots.in.it.salt';
      const parsed = parseSessionState(sessionState);

      expect(parsed).not.toBeNull();
      expect(parsed?.hash).toBe('hash.with.dots.in.it');
      expect(parsed?.salt).toBe('salt');
    });

    it('should return null for invalid session state without dot', () => {
      const sessionState = 'nodothere';
      const parsed = parseSessionState(sessionState);

      expect(parsed).toBeNull();
    });

    it('should return null for session state with empty hash', () => {
      const sessionState = '.salt';
      const parsed = parseSessionState(sessionState);

      expect(parsed).toBeNull();
    });

    it('should return null for session state with empty salt', () => {
      const sessionState = 'hash.';
      const parsed = parseSessionState(sessionState);

      expect(parsed).toBeNull();
    });
  });

  describe('validateSessionState', () => {
    it('should validate correct session state', async () => {
      const clientId = 'test-client';
      const origin = 'https://rp.example.com';
      const opBrowserState = 'session-123';
      const salt = 'fixed-salt';

      const sessionState = await calculateSessionState(clientId, origin, opBrowserState, salt);
      const isValid = await validateSessionState(sessionState, clientId, origin, opBrowserState);

      expect(isValid).toBe(true);
    });

    it('should reject session state with wrong client_id', async () => {
      const origin = 'https://rp.example.com';
      const opBrowserState = 'session-123';
      const salt = 'fixed-salt';

      const sessionState = await calculateSessionState(
        'correct-client',
        origin,
        opBrowserState,
        salt
      );
      const isValid = await validateSessionState(
        sessionState,
        'wrong-client',
        origin,
        opBrowserState
      );

      expect(isValid).toBe(false);
    });

    it('should reject session state with wrong origin', async () => {
      const clientId = 'test-client';
      const opBrowserState = 'session-123';
      const salt = 'fixed-salt';

      const sessionState = await calculateSessionState(
        clientId,
        'https://correct.com',
        opBrowserState,
        salt
      );
      const isValid = await validateSessionState(
        sessionState,
        clientId,
        'https://wrong.com',
        opBrowserState
      );

      expect(isValid).toBe(false);
    });

    it('should reject session state with wrong opBrowserState', async () => {
      const clientId = 'test-client';
      const origin = 'https://rp.example.com';
      const salt = 'fixed-salt';

      const sessionState = await calculateSessionState(clientId, origin, 'correct-session', salt);
      const isValid = await validateSessionState(sessionState, clientId, origin, 'wrong-session');

      expect(isValid).toBe(false);
    });

    it('should reject malformed session state', async () => {
      const isValid = await validateSessionState('invalid', 'client', 'origin', 'session');

      expect(isValid).toBe(false);
    });

    it('should reject tampered session state', async () => {
      const clientId = 'test-client';
      const origin = 'https://rp.example.com';
      const opBrowserState = 'session-123';
      const salt = 'fixed-salt';

      const sessionState = await calculateSessionState(clientId, origin, opBrowserState, salt);
      const tamperedSessionState = 'tamperedhash.' + sessionState.split('.').pop();

      const isValid = await validateSessionState(
        tamperedSessionState,
        clientId,
        origin,
        opBrowserState
      );

      expect(isValid).toBe(false);
    });
  });

  describe('extractOrigin', () => {
    it('should extract origin from HTTPS URL', () => {
      const url = 'https://example.com/path?query=value';
      const origin = extractOrigin(url);

      expect(origin).toBe('https://example.com');
    });

    it('should extract origin from HTTP URL', () => {
      const url = 'http://example.com:8080/path';
      const origin = extractOrigin(url);

      expect(origin).toBe('http://example.com:8080');
    });

    it('should extract origin from URL with port', () => {
      const url = 'https://example.com:3000/callback';
      const origin = extractOrigin(url);

      expect(origin).toBe('https://example.com:3000');
    });

    it('should extract origin from localhost URL', () => {
      const url = 'http://localhost:8787/authorize';
      const origin = extractOrigin(url);

      expect(origin).toBe('http://localhost:8787');
    });

    it('should return empty string for invalid URL', () => {
      const url = 'not-a-valid-url';
      const origin = extractOrigin(url);

      expect(origin).toBe('');
    });

    it('should handle URL with subdomain', () => {
      const url = 'https://sub.example.com/path';
      const origin = extractOrigin(url);

      expect(origin).toBe('https://sub.example.com');
    });
  });

  describe('generateCheckSessionIframeHtml', () => {
    const issuerUrl = 'https://op.example.com';

    it('should generate valid HTML', () => {
      const html = generateCheckSessionIframeHtml(issuerUrl);

      expect(html).toBeDefined();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html>');
      expect(html).toContain('</html>');
    });

    it('should contain session cookie reading logic', () => {
      const html = generateCheckSessionIframeHtml(issuerUrl);

      expect(html).toContain('authrim_session');
      expect(html).toContain('getOpBrowserState');
    });

    it('should contain SHA-256 hashing logic', () => {
      const html = generateCheckSessionIframeHtml(issuerUrl);

      expect(html).toContain('SHA-256');
      expect(html).toContain('sha256Base64Url');
    });

    it('should contain postMessage event listener', () => {
      const html = generateCheckSessionIframeHtml(issuerUrl);

      expect(html).toContain("window.addEventListener('message'");
      expect(html).toContain('postMessage');
    });

    it('should handle session state validation response types', () => {
      const html = generateCheckSessionIframeHtml(issuerUrl);

      expect(html).toContain("'changed'");
      expect(html).toContain("'unchanged'");
      expect(html).toContain("'error'");
    });

    it('should contain session state format validation', () => {
      const html = generateCheckSessionIframeHtml(issuerUrl);

      expect(html).toContain('lastIndexOf');
      expect(html).toContain('substring');
    });
  });
});

describe('Session State Format Compliance', () => {
  it('should produce session state in format: hash.salt', async () => {
    const sessionState = await calculateSessionState(
      'client',
      'https://origin.com',
      'session',
      'salt'
    );
    const parts = sessionState.split('.');

    // Should have at least 2 parts (hash.salt)
    expect(parts.length).toBeGreaterThanOrEqual(2);

    // Last part should be the salt
    expect(parts[parts.length - 1]).toBe('salt');
  });

  it('should produce base64url-encoded hash', async () => {
    const sessionState = await calculateSessionState(
      'client',
      'https://origin.com',
      'session',
      'salt'
    );
    const hash = sessionState.split('.').slice(0, -1).join('.');

    // Base64url should not contain +, /, or =
    expect(hash).not.toMatch(/[+/=]/);
    // Should only contain valid base64url characters
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
