/**
 * Tests for Form Post Response Mode
 * OAuth 2.0 Form Post Response Mode - https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import type { Env } from '../src/types/env';
import { createMockEnv } from './integration/fixtures';

describe('Form Post Response Mode', () => {
  let env: Env;

  beforeEach(async () => {
    env = await createMockEnv();
  });

  describe('Authorization endpoint with response_mode=form_post', () => {
    it('should return HTML form when response_mode=form_post', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const contentType = res.headers.get('Content-Type');
      expect(contentType).toContain('text/html');

      const html = await res.text();

      // Verify HTML structure
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html');
      expect(html).toContain('</html>');

      // Verify form element
      expect(html).toContain('<form');
      expect(html).toContain('method="post"');
      expect(html).toContain('action="https://example.com/callback"');

      // Verify form inputs
      expect(html).toContain('name="code"');
      expect(html).toContain('type="hidden"');

      // Verify auto-submit script
      expect(html).toContain('<script>');
      expect(html).toContain('.submit()');
    });

    it('should include state parameter in form when provided', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&state=test-state-123&response_mode=form_post',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Verify state is included in form
      expect(html).toContain('name="state"');
      expect(html).toContain('value="test-state-123"');
    });

    it('should escape HTML special characters in redirect_uri', async () => {
      // Test with redirect_uri containing special characters
      const redirectUri = 'https://example.com/callback?foo=bar&baz=qux';
      const encodedUri = encodeURIComponent(redirectUri);

      const res = await app.request(
        `/authorize?response_type=code&client_id=test_client&redirect_uri=${encodedUri}&scope=openid&response_mode=form_post`,
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Verify that HTML special characters are escaped
      expect(html).toContain('&amp;'); // & should be escaped as &amp;
      expect(html).not.toContain('action="https://example.com/callback?foo=bar&baz=qux"'); // raw & should not appear
    });

    it('should escape HTML special characters in code value', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // The code value should be HTML-escaped
      // Extract code value (it will be between value=" and ")
      const codeMatch = html.match(/name="code".*?value="([^"]+)"/);
      expect(codeMatch).toBeTruthy();

      const codeValue = codeMatch![1];

      // Verify no unescaped special characters
      expect(codeValue).not.toContain('<');
      expect(codeValue).not.toContain('>');
      expect(codeValue).not.toContain('"');
    });

    it('should work with POST request to authorize endpoint', async () => {
      const formData = new URLSearchParams({
        response_type: 'code',
        client_id: 'test_client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid',
        response_mode: 'form_post',
        state: 'test-state',
      });

      const res = await app.request(
        '/authorize',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      expect(html).toContain('<form');
      expect(html).toContain('action="https://example.com/callback"');
      expect(html).toContain('name="code"');
      expect(html).toContain('name="state"');
      expect(html).toContain('value="test-state"');
    });
  });

  describe('Response mode validation', () => {
    it('should accept response_mode=query (default)', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=query',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(302);

      const location = res.headers.get('Location');
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
    });

    it('should default to query mode when response_mode not specified', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(302);

      const location = res.headers.get('Location');
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
    });

    it('should reject unsupported response_mode', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=unsupported',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(302);

      const location = res.headers.get('Location');
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('Unsupported response_mode');
    });

    it('should reject fragment mode for response_type=code', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=fragment',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(302);

      const location = res.headers.get('Location');
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain(
        'response_mode=fragment is not compatible with response_type=code'
      );
    });
  });

  describe('Form Post with PKCE', () => {
    it('should support form_post with PKCE parameters', async () => {
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

      const res = await app.request(
        `/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post&code_challenge=${codeChallenge}&code_challenge_method=S256`,
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      expect(html).toContain('<form');
      expect(html).toContain('name="code"');
    });
  });

  describe('Form Post with PAR', () => {
    let testClient: { client_id: string; client_secret: string; redirect_uris: string[] };

    beforeEach(async () => {
      // Create a test client using Dynamic Client Registration
      const registrationBody = {
        redirect_uris: ['https://example.com/callback'],
        client_name: 'Test Client for Form Post',
        scope: 'openid profile email',
      };

      const registrationRes = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(registrationBody),
        },
        env
      );

      const registrationData = await registrationRes.json();
      testClient = {
        client_id: registrationData.client_id,
        client_secret: registrationData.client_secret,
        redirect_uris: registrationData.redirect_uris,
      };
    });

    it('should support form_post via PAR request_uri', async () => {
      // Step 1: Push authorization request with response_mode=form_post
      const parFormData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
        response_mode: 'form_post',
        state: 'test-state',
      });

      const parRes = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: parFormData.toString(),
        },
        env
      );

      expect(parRes.status).toBe(201);

      const parData = await parRes.json();
      const requestUri = parData.request_uri;

      // Step 2: Use request_uri in authorization request
      const authRes = await app.request(
        `/authorize?client_id=${testClient.client_id}&request_uri=${encodeURIComponent(requestUri)}`,
        { method: 'GET' },
        env
      );

      expect(authRes.status).toBe(200);

      const html = await authRes.text();

      // Verify form_post response
      expect(html).toContain('<form');
      expect(html).toContain(`action="${testClient.redirect_uris[0]}"`);
      expect(html).toContain('name="code"');
      expect(html).toContain('name="state"');
      expect(html).toContain('value="test-state"');
    });
  });

  describe('Discovery endpoint', () => {
    it('should advertise form_post in response_modes_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration', { method: 'GET' }, env);

      expect(res.status).toBe(200);

      const metadata = await res.json();
      expect(metadata).toHaveProperty('response_modes_supported');
      expect(metadata.response_modes_supported).toContain('query');
      expect(metadata.response_modes_supported).toContain('form_post');
    });
  });

  describe('Security - XSS Prevention', () => {
    it('should escape HTML in state parameter', async () => {
      const maliciousState = '<script>alert("XSS")</script>';
      const encodedState = encodeURIComponent(maliciousState);

      const res = await app.request(
        `/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post&state=${encodedState}`,
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Verify that script tags are escaped
      expect(html).not.toContain('<script>alert("XSS")</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;/script&gt;');
    });

    it('should escape quotes in parameters', async () => {
      const stateWithQuotes = 'test"state\'with"quotes';
      const encodedState = encodeURIComponent(stateWithQuotes);

      const res = await app.request(
        `/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post&state=${encodedState}`,
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Verify quotes are escaped
      expect(html).toContain('&quot;'); // " escaped
      expect(html).toContain('&#039;'); // ' escaped
    });

    it('should escape ampersands in parameters', async () => {
      const stateWithAmpersand = 'state&with&ampersands';
      const encodedState = encodeURIComponent(stateWithAmpersand);

      const res = await app.request(
        `/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post&state=${encodedState}`,
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Verify ampersands are escaped
      expect(html).toContain('&amp;');
    });
  });

  describe('HTML Form Structure', () => {
    it('should include proper HTML5 doctype and meta tags', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<meta charset="UTF-8">');
      expect(html).toContain('<meta name="viewport"');
    });

    it('should include user-friendly loading message', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Should have a user-friendly message
      expect(html).toContain('Redirecting');
    });

    it('should include loading spinner or visual feedback', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Should have spinner CSS
      expect(html).toContain('spinner');
      expect(html).toContain('animation');
    });

    it('should have form id for JavaScript auto-submit', async () => {
      const res = await app.request(
        '/authorize?response_type=code&client_id=test_client&redirect_uri=https://example.com/callback&scope=openid&response_mode=form_post',
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);

      const html = await res.text();

      // Form should have an ID
      expect(html).toContain('id="auth-form"');

      // Script should reference the form ID
      expect(html).toContain('getElementById(\'auth-form\')');
    });
  });
});
