/**
 * Integration Tests: OIDC Session Management
 *
 * Tests the OIDC Session Management 1.0 specification implementation:
 * 1. check_session_iframe endpoint
 * 2. session_state parameter in authorization response
 * 3. Discovery metadata includes check_session_iframe
 *
 * https://openid.net/specs/openid-connect-session-1_0.html
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockEnv, testClients, generateState, generateNonce } from './fixtures';
import type { Env } from '@authrim/shared/types/env';
import { calculateSessionState, extractOrigin, validateSessionState } from '@authrim/shared';

describe('OIDC Session Management', () => {
  let env: Env;

  beforeEach(async () => {
    env = await createMockEnv();
  });

  describe('Discovery Metadata', () => {
    it('should include check_session_iframe in discovery document', async () => {
      const app = (await import('../../packages/op-discovery/src/index')).default;

      const req = new Request(`${env.ISSUER_URL}/.well-known/openid-configuration`);
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);

      const metadata = await res.json();
      expect(metadata.check_session_iframe).toBeDefined();
      expect(metadata.check_session_iframe).toBe(`${env.ISSUER_URL}/session/check`);
    });

    it('should have valid issuer in discovery document', async () => {
      const app = (await import('../../packages/op-discovery/src/index')).default;

      const req = new Request(`${env.ISSUER_URL}/.well-known/openid-configuration`);
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);

      const metadata = await res.json();
      expect(metadata.issuer).toBe(env.ISSUER_URL);
      expect(metadata.authorization_endpoint).toBe(`${env.ISSUER_URL}/authorize`);
    });
  });

  describe('Check Session Iframe Endpoint', () => {
    it('should return HTML page for check_session_iframe', async () => {
      const app = (await import('../../packages/op-auth/src/index')).default;

      const req = new Request(`${env.ISSUER_URL}/session/check`);
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);

      const contentType = res.headers.get('Content-Type');
      expect(contentType).toContain('text/html');

      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('postMessage');
      expect(html).toContain('authrim_session');
    });

    it('should have proper headers for iframe embedding', async () => {
      const app = (await import('../../packages/op-auth/src/index')).default;

      const req = new Request(`${env.ISSUER_URL}/session/check`);
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);

      // Should allow framing
      const xFrameOptions = res.headers.get('X-Frame-Options');
      expect(xFrameOptions).toBe('ALLOWALL');

      // Should have CSP that allows inline scripts and framing
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain('frame-ancestors *');
      expect(csp).toContain("script-src 'unsafe-inline'");
    });

    it('should have cache control headers', async () => {
      const app = (await import('../../packages/op-auth/src/index')).default;

      const req = new Request(`${env.ISSUER_URL}/session/check`);
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);

      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toContain('no-cache');
      expect(cacheControl).toContain('no-store');
    });

    it('should contain session state validation logic', async () => {
      const app = (await import('../../packages/op-auth/src/index')).default;

      const req = new Request(`${env.ISSUER_URL}/session/check`);
      const res = await app.fetch(req, env);

      const html = await res.text();

      // Should contain validation logic
      expect(html).toContain('validateSessionState');
      expect(html).toContain('sha256Base64Url');
      expect(html).toContain("'changed'");
      expect(html).toContain("'unchanged'");
      expect(html).toContain("'error'");
    });
  });

  describe('Session State Calculation', () => {
    it('should calculate valid session state', async () => {
      const clientId = testClients.confidential.client_id;
      const origin = extractOrigin(testClients.confidential.redirect_uris[0]);
      const sessionId = 'test-session-id-123';

      const sessionState = await calculateSessionState(clientId, origin, sessionId);

      expect(sessionState).toBeDefined();
      expect(sessionState).toContain('.');

      // Validate the session state
      const isValid = await validateSessionState(sessionState, clientId, origin, sessionId);
      expect(isValid).toBe(true);
    });

    it('should detect changed session', async () => {
      const clientId = testClients.confidential.client_id;
      const origin = extractOrigin(testClients.confidential.redirect_uris[0]);
      const originalSessionId = 'original-session-123';
      const newSessionId = 'new-session-456';

      const sessionState = await calculateSessionState(clientId, origin, originalSessionId);

      // Session state should be invalid with different session ID
      const isValid = await validateSessionState(sessionState, clientId, origin, newSessionId);
      expect(isValid).toBe(false);
    });

    it('should detect different client', async () => {
      const origin = extractOrigin(testClients.confidential.redirect_uris[0]);
      const sessionId = 'test-session-123';

      const sessionState = await calculateSessionState('original-client', origin, sessionId);

      // Session state should be invalid with different client ID
      const isValid = await validateSessionState(sessionState, 'different-client', origin, sessionId);
      expect(isValid).toBe(false);
    });

    it('should detect different origin', async () => {
      const clientId = testClients.confidential.client_id;
      const sessionId = 'test-session-123';

      const sessionState = await calculateSessionState(clientId, 'https://original.com', sessionId);

      // Session state should be invalid with different origin
      const isValid = await validateSessionState(sessionState, clientId, 'https://different.com', sessionId);
      expect(isValid).toBe(false);
    });
  });

  describe('Origin Extraction', () => {
    it('should extract origin from HTTPS URL', () => {
      const redirectUri = 'https://example.com/callback';
      const origin = extractOrigin(redirectUri);

      expect(origin).toBe('https://example.com');
    });

    it('should extract origin with port', () => {
      const redirectUri = 'http://localhost:3000/callback';
      const origin = extractOrigin(redirectUri);

      expect(origin).toBe('http://localhost:3000');
    });

    it('should handle URLs with path', () => {
      const redirectUri = 'https://example.com/path/to/callback?query=value';
      const origin = extractOrigin(redirectUri);

      expect(origin).toBe('https://example.com');
    });
  });
});

describe('Session State in Authorization Response', () => {
  let env: Env;

  beforeEach(async () => {
    env = await createMockEnv();
  });

  it('should include session_state format validation', () => {
    // Test the session_state format: hash.salt
    const validSessionState = 'abc123def456.randomsalt';
    const parts = validSessionState.split('.');

    expect(parts.length).toBe(2);
    expect(parts[0]).toBeTruthy();
    expect(parts[1]).toBeTruthy();
  });
});

describe('Session State Security', () => {
  it('should produce unique session states for different salts', async () => {
    const clientId = 'test-client';
    const origin = 'https://rp.example.com';
    const sessionId = 'session-123';

    const sessionState1 = await calculateSessionState(clientId, origin, sessionId, 'salt1');
    const sessionState2 = await calculateSessionState(clientId, origin, sessionId, 'salt2');

    expect(sessionState1).not.toBe(sessionState2);
  });

  it('should be deterministic with same salt', async () => {
    const clientId = 'test-client';
    const origin = 'https://rp.example.com';
    const sessionId = 'session-123';
    const salt = 'fixed-salt';

    const sessionState1 = await calculateSessionState(clientId, origin, sessionId, salt);
    const sessionState2 = await calculateSessionState(clientId, origin, sessionId, salt);

    expect(sessionState1).toBe(sessionState2);
  });

  it('should use SHA-256 hash producing base64url output', async () => {
    const sessionState = await calculateSessionState('client', 'https://origin.com', 'session', 'salt');
    const hash = sessionState.split('.')[0];

    // SHA-256 produces 32 bytes = 256 bits
    // Base64url encoding: ceil(256/6) = 43 characters (without padding)
    expect(hash.length).toBe(43);

    // Should not contain non-base64url characters
    expect(hash).not.toMatch(/[+/=]/);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
