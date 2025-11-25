/**
 * Tests for PAR (Pushed Authorization Requests) endpoint
 * RFC 9126 - OAuth 2.0 Pushed Authorization Requests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/index';
import type { Env } from '@authrim/shared/types/env';
import { createMockEnv } from './fixtures';

describe('PAR (Pushed Authorization Requests) - RFC 9126', () => {
  let env: Env;
  let testClient: { client_id: string; client_secret: string; redirect_uris: string[] };

  beforeEach(async () => {
    env = await createMockEnv();

    // Create a test client using Dynamic Client Registration
    const registrationBody = {
      redirect_uris: ['https://example.com/callback', 'http://localhost:3000/callback'],
      client_name: 'Test Client',
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

  describe('POST /as/par', () => {
    it('should accept valid PAR request and return request_uri', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid profile email',
        state: 'test-state',
        nonce: 'test-nonce',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data).toHaveProperty('request_uri');
      expect(data).toHaveProperty('expires_in');
      expect(data.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
      expect(data.expires_in).toBe(600);
    });

    it('should reject GET requests', async () => {
      const res = await app.request('/as/par', { method: 'GET' }, env);

      expect(res.status).toBe(405);

      const data = await res.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('POST');
    });

    it('should reject requests without Content-Type application/x-www-form-urlencoded', async () => {
      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: testClient.client_id,
            response_type: 'code',
            redirect_uri: testClient.redirect_uris[0],
            scope: 'openid',
          }),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('application/x-www-form-urlencoded');
    });

    it('should reject request with missing client_id', async () => {
      const formData = new URLSearchParams({
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('client_id');
    });

    it('should reject request with invalid client_id', async () => {
      const formData = new URLSearchParams({
        client_id: 'invalid-client',
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('invalid_client');
    });

    it('should reject request with unregistered redirect_uri', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: 'https://malicious.com/callback',
        scope: 'openid',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('redirect_uri');
    });

    it('should reject request with missing response_type', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('response_type');
    });

    it('should reject request with unsupported response_type', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'token',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('unsupported_response_type');
    });

    it('should accept PAR request with PKCE parameters', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data).toHaveProperty('request_uri');
      expect(data).toHaveProperty('expires_in');
    });

    it('should reject PAR request with code_challenge but missing code_challenge_method', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('code_challenge_method');
    });

    it('should reject PAR request with invalid code_challenge length', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
        code_challenge: 'short',
        code_challenge_method: 'S256',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('code_challenge');
    });

    it('should accept PAR request with optional parameters', async () => {
      const formData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid profile email',
        state: 'test-state',
        nonce: 'test-nonce',
        prompt: 'login',
        max_age: '3600',
        ui_locales: 'ja en',
      });

      const res = await app.request(
        '/as/par',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
        env
      );

      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data).toHaveProperty('request_uri');
      expect(data).toHaveProperty('expires_in');
    });
  });

  describe('Authorization endpoint with request_uri', () => {
    it('should accept request_uri from PAR and process authorization', async () => {
      // Step 1: Push authorization request
      const parFormData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
        state: 'test-state',
        nonce: 'test-nonce',
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

      expect(authRes.status).toBe(302);

      const location = authRes.headers.get('Location');
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
      expect(redirectUrl.searchParams.get('state')).toBe('test-state');
    });

    it('should reject invalid request_uri format', async () => {
      const authRes = await app.request(
        `/authorize?client_id=${testClient.client_id}&request_uri=invalid-uri`,
        { method: 'GET' },
        env
      );

      expect(authRes.status).toBe(400);

      const data = await authRes.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('Invalid request_uri format');
    });

    it('should reject expired or non-existent request_uri', async () => {
      const requestUri = 'urn:ietf:params:oauth:request_uri:non-existent';

      const authRes = await app.request(
        `/authorize?client_id=${testClient.client_id}&request_uri=${encodeURIComponent(requestUri)}`,
        { method: 'GET' },
        env
      );

      expect(authRes.status).toBe(400);

      const data = await authRes.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('Invalid or expired request_uri');
    });

    it('should reject request_uri with mismatched client_id', async () => {
      // Create another client using Dynamic Client Registration
      const registrationBody = {
        redirect_uris: ['https://another.example.com/callback'],
        client_name: 'Another Test Client',
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
      const anotherClient = {
        client_id: registrationData.client_id,
        client_secret: registrationData.client_secret,
        redirect_uris: registrationData.redirect_uris,
      };

      // Step 1: Push authorization request with first client
      const parFormData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
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

      const parData = await parRes.json();
      const requestUri = parData.request_uri;

      // Step 2: Try to use request_uri with different client_id
      const authRes = await app.request(
        `/authorize?client_id=${anotherClient.client_id}&request_uri=${encodeURIComponent(requestUri)}`,
        { method: 'GET' },
        env
      );

      expect(authRes.status).toBe(400);

      const data = await authRes.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('client_id mismatch');
    });

    it('should delete request_uri after single use', async () => {
      // Step 1: Push authorization request
      const parFormData = new URLSearchParams({
        client_id: testClient.client_id,
        response_type: 'code',
        redirect_uri: testClient.redirect_uris[0],
        scope: 'openid',
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

      const parData = await parRes.json();
      const requestUri = parData.request_uri;

      // Step 2: Use request_uri in authorization request (first time)
      const authRes1 = await app.request(
        `/authorize?client_id=${testClient.client_id}&request_uri=${encodeURIComponent(requestUri)}`,
        { method: 'GET' },
        env
      );

      expect(authRes1.status).toBe(302);

      // Step 3: Try to reuse request_uri (should fail)
      const authRes2 = await app.request(
        `/authorize?client_id=${testClient.client_id}&request_uri=${encodeURIComponent(requestUri)}`,
        { method: 'GET' },
        env
      );

      expect(authRes2.status).toBe(400);

      const data = await authRes2.json();
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('Invalid or expired request_uri');
    });
  });

  describe('Discovery endpoint', () => {
    it('should advertise PAR endpoint in discovery metadata', async () => {
      const res = await app.request('/.well-known/openid-configuration', { method: 'GET' }, env);

      expect(res.status).toBe(200);

      const metadata = await res.json();
      expect(metadata).toHaveProperty('pushed_authorization_request_endpoint');
      expect(metadata.pushed_authorization_request_endpoint).toContain('/as/par');
      expect(metadata).toHaveProperty('require_pushed_authorization_requests');
      expect(metadata.require_pushed_authorization_requests).toBe(false);
    });
  });
});
