/**
 * Logout Integration Tests
 *
 * Integration tests for OIDC Logout functionality:
 * - Front-channel logout with multiple clients
 * - Session-based logout propagation
 * - Logout configuration from KV
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildFrontchannelLogoutUri,
  buildFrontchannelLogoutIframes,
  generateFrontchannelLogoutHtml,
  shouldUseFrontchannelLogout,
} from '@authrim/ar-lib-core';
import type { FrontchannelLogoutConfig } from '@authrim/ar-lib-core';
import type { SessionClientWithDetails } from '@authrim/ar-lib-core';

describe('Logout Integration', () => {
  describe('Frontchannel Logout Flow', () => {
    const mockConfig: FrontchannelLogoutConfig = {
      enabled: true,
      iframe_timeout_ms: 5000,
      max_concurrent_iframes: 10,
    };

    const mockClients: SessionClientWithDetails[] = [
      {
        id: 'sc-1',
        session_id: 'session-123',
        client_id: 'client-a',
        tenant_id: 'default',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Application A',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: 'https://app-a.example.com/fc-logout',
        frontchannel_logout_session_required: true,
      },
      {
        id: 'sc-2',
        session_id: 'session-123',
        client_id: 'client-b',
        tenant_id: 'default',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Application B',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: 'https://app-b.example.com/logout',
        frontchannel_logout_session_required: false,
      },
      {
        id: 'sc-3',
        session_id: 'session-123',
        client_id: 'client-c',
        tenant_id: 'default',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Application C (no frontchannel)',
        backchannel_logout_uri: 'https://app-c.example.com/bc-logout',
        backchannel_logout_session_required: true,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: false,
      },
    ];

    it('should generate complete frontchannel logout flow', () => {
      const issuer = 'https://auth.example.com';
      const sessionId = 'session-123';
      const postLogoutRedirectUri = 'https://app-a.example.com/logged-out';

      // Step 1: Build iframes from session clients
      const iframes = buildFrontchannelLogoutIframes(mockClients, issuer, sessionId);

      // Verify only clients with frontchannel_logout_uri are included
      expect(iframes).toHaveLength(2);
      expect(iframes.map((i) => i.clientId)).toEqual(['client-a', 'client-b']);

      // Step 2: Verify URI parameters
      const iframeA = iframes.find((i) => i.clientId === 'client-a')!;
      const urlA = new URL(iframeA.logoutUri);
      expect(urlA.searchParams.get('iss')).toBe(issuer);
      expect(urlA.searchParams.get('sid')).toBe(sessionId); // session_required = true

      const iframeB = iframes.find((i) => i.clientId === 'client-b')!;
      const urlB = new URL(iframeB.logoutUri);
      expect(urlB.searchParams.get('iss')).toBe(issuer);
      expect(urlB.searchParams.get('sid')).toBeNull(); // session_required = false

      // Step 3: Generate HTML page
      const html = generateFrontchannelLogoutHtml(
        iframes,
        mockConfig,
        postLogoutRedirectUri,
        'state123'
      );

      // Verify HTML structure
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Logging out...');

      // Verify iframes are included
      expect(html).toContain('app-a.example.com/fc-logout');
      expect(html).toContain('app-b.example.com/logout');

      // Verify redirect and state
      expect(html).toContain('https://app-a.example.com/logged-out');
      expect(html).toContain('state=state123');

      // Verify timeout
      expect(html).toContain('5000'); // iframe_timeout_ms
    });

    it('should respect max_concurrent_iframes limit', () => {
      // Create 15 clients with frontchannel logout
      const manyClients: SessionClientWithDetails[] = Array.from({ length: 15 }, (_, i) => ({
        id: `sc-${i}`,
        session_id: 'session-123',
        client_id: `client-${i}`,
        tenant_id: 'default',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: `Application ${i}`,
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: `https://app-${i}.example.com/logout`,
        frontchannel_logout_session_required: false,
      }));

      const iframes = buildFrontchannelLogoutIframes(
        manyClients,
        'https://auth.example.com',
        'session-123'
      );

      // Build HTML with limit of 5
      const limitedConfig: FrontchannelLogoutConfig = {
        enabled: true,
        iframe_timeout_ms: 3000,
        max_concurrent_iframes: 5,
      };

      const html = generateFrontchannelLogoutHtml(
        iframes,
        limitedConfig,
        'https://example.com/callback'
      );

      // Count iframes in HTML
      const iframeMatches = html.match(/logout-frame-\d+/g) || [];
      expect(iframeMatches.length).toBe(5);
    });

    it('should handle clients with existing query parameters in logout URI', () => {
      const clientWithParams: SessionClientWithDetails = {
        id: 'sc-1',
        session_id: 'session-123',
        client_id: 'client-x',
        tenant_id: 'default',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Application X',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: 'https://app-x.example.com/logout?existing=param&foo=bar',
        frontchannel_logout_session_required: true,
      };

      const uri = buildFrontchannelLogoutUri(
        clientWithParams.frontchannel_logout_uri!,
        'https://auth.example.com',
        'session-456',
        true
      );

      const url = new URL(uri);
      expect(url.searchParams.get('existing')).toBe('param');
      expect(url.searchParams.get('foo')).toBe('bar');
      expect(url.searchParams.get('iss')).toBe('https://auth.example.com');
      expect(url.searchParams.get('sid')).toBe('session-456');
    });

    it('should correctly determine when to use frontchannel logout', () => {
      // When enabled and clients have frontchannel_logout_uri
      expect(shouldUseFrontchannelLogout(mockClients, mockConfig)).toBe(true);

      // When disabled
      expect(shouldUseFrontchannelLogout(mockClients, { ...mockConfig, enabled: false })).toBe(
        false
      );

      // When no clients have frontchannel_logout_uri
      const noFrontchannelClients: SessionClientWithDetails[] = [
        {
          id: 'sc-1',
          session_id: 'session-123',
          client_id: 'client-z',
          tenant_id: 'default',
          first_token_at: Date.now(),
          last_token_at: Date.now(),
          last_seen_at: null,
          client_name: 'Application Z',
          backchannel_logout_uri: 'https://app-z.example.com/bc-logout',
          backchannel_logout_session_required: true,
          frontchannel_logout_uri: null,
          frontchannel_logout_session_required: false,
        },
      ];
      expect(shouldUseFrontchannelLogout(noFrontchannelClients, mockConfig)).toBe(false);

      // Empty clients array
      expect(shouldUseFrontchannelLogout([], mockConfig)).toBe(false);
    });
  });

  describe('Security: XSS Prevention', () => {
    const mockConfig: FrontchannelLogoutConfig = {
      enabled: true,
      iframe_timeout_ms: 3000,
      max_concurrent_iframes: 10,
    };

    it('should escape malicious content in logout URIs', () => {
      const maliciousClient: SessionClientWithDetails = {
        id: 'sc-1',
        session_id: 'session-123',
        client_id: 'malicious',
        tenant_id: 'default',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Malicious App',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: 'https://evil.com/logout?xss=<script>alert("xss")</script>',
        frontchannel_logout_session_required: false,
      };

      const iframes = buildFrontchannelLogoutIframes(
        [maliciousClient],
        'https://auth.example.com',
        'session-123'
      );

      const html = generateFrontchannelLogoutHtml(
        iframes,
        mockConfig,
        'https://example.com/callback'
      );

      // Raw script tags should not appear in the output
      // The URL API encodes < and > as %3C and %3E, and the HTML escaper
      // further protects against any remaining special characters
      expect(html).not.toContain('<script>alert("xss")</script>');
      // The malicious script is URL-encoded by the URL API
      expect(html).toContain('evil.com');
      // Verify the URL is properly encoded
      expect(iframes[0].logoutUri).toContain('%3Cscript%3E');
    });

    it('should escape special HTML characters in redirect URI', () => {
      const iframes = [
        {
          clientId: 'client-1',
          logoutUri: 'https://app.example.com/logout',
          sessionRequired: false,
        },
      ];

      // Try to inject via post_logout_redirect_uri with direct HTML injection attempt
      const maliciousRedirectUri = 'https://example.com/callback?xss="><script>alert(1)</script>';

      const html = generateFrontchannelLogoutHtml(iframes, mockConfig, maliciousRedirectUri);

      // The redirect URL in JavaScript should be escaped
      // Raw script tag should not appear
      expect(html).not.toContain('<script>alert(1)</script>');
      // The URL should be present but escaped
      expect(html).toContain('example.com/callback');
    });
  });

  describe('Multi-Session Logout', () => {
    it('should handle logout for multiple sessions of same user', () => {
      const session1Clients: SessionClientWithDetails[] = [
        {
          id: 'sc-1',
          session_id: 'session-1',
          client_id: 'client-a',
          tenant_id: 'default',
          first_token_at: Date.now(),
          last_token_at: Date.now(),
          last_seen_at: null,
          client_name: 'App A',
          backchannel_logout_uri: null,
          backchannel_logout_session_required: false,
          frontchannel_logout_uri: 'https://app-a.example.com/logout',
          frontchannel_logout_session_required: true,
        },
      ];

      const session2Clients: SessionClientWithDetails[] = [
        {
          id: 'sc-2',
          session_id: 'session-2',
          client_id: 'client-b',
          tenant_id: 'default',
          first_token_at: Date.now(),
          last_token_at: Date.now(),
          last_seen_at: null,
          client_name: 'App B',
          backchannel_logout_uri: null,
          backchannel_logout_session_required: false,
          frontchannel_logout_uri: 'https://app-b.example.com/logout',
          frontchannel_logout_session_required: true,
        },
      ];

      const issuer = 'https://auth.example.com';

      // Build iframes for session 1
      const iframes1 = buildFrontchannelLogoutIframes(session1Clients, issuer, 'session-1');
      expect(iframes1[0].logoutUri).toContain('sid=session-1');

      // Build iframes for session 2
      const iframes2 = buildFrontchannelLogoutIframes(session2Clients, issuer, 'session-2');
      expect(iframes2[0].logoutUri).toContain('sid=session-2');

      // Combined iframes for both sessions
      const allIframes = [...iframes1, ...iframes2];
      expect(allIframes).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    const mockConfig: FrontchannelLogoutConfig = {
      enabled: true,
      iframe_timeout_ms: 3000,
      max_concurrent_iframes: 10,
    };

    it('should handle empty clients array', () => {
      const iframes = buildFrontchannelLogoutIframes([], 'https://auth.example.com', 'session-123');

      expect(iframes).toEqual([]);
    });

    it('should handle all clients without frontchannel_logout_uri', () => {
      const backchannelOnlyClients: SessionClientWithDetails[] = [
        {
          id: 'sc-1',
          session_id: 'session-123',
          client_id: 'client-1',
          tenant_id: 'default',
          first_token_at: Date.now(),
          last_token_at: Date.now(),
          last_seen_at: null,
          client_name: 'Backchannel Only',
          backchannel_logout_uri: 'https://app.example.com/bc-logout',
          backchannel_logout_session_required: true,
          frontchannel_logout_uri: null,
          frontchannel_logout_session_required: false,
        },
      ];

      const iframes = buildFrontchannelLogoutIframes(
        backchannelOnlyClients,
        'https://auth.example.com',
        'session-123'
      );

      expect(iframes).toEqual([]);
    });

    it('should handle URI with special characters', () => {
      const uri = buildFrontchannelLogoutUri(
        'https://app.example.com/logout',
        'https://auth.example.com',
        'session-with-special-chars-日本語',
        true
      );

      const url = new URL(uri);
      expect(url.searchParams.get('sid')).toBe('session-with-special-chars-日本語');
    });

    it('should generate HTML even with zero iframes', () => {
      const html = generateFrontchannelLogoutHtml([], mockConfig, 'https://example.com/callback');

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Logging out...');
      // Should immediately redirect since no iframes
      expect(html).toContain('setTimeout(doRedirect');
    });
  });
});
