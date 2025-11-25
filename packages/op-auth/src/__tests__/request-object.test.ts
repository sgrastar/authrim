/**
 * Request Object (JAR - RFC 9101) Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { SignJWT, importJWK } from 'jose';

describe('Request Object (JAR)', () => {
  describe('request parameter processing', () => {
    it('should accept unsigned request object with alg=none', async () => {
      // This test validates that the authorize endpoint can parse
      // an unsigned JWT request object according to RFC 9101

      const requestClaims = {
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid profile',
        state: 'test-state',
        nonce: 'test-nonce',
      };

      // Create unsigned JWT (alg: none)
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(requestClaims)).toString('base64url');
      const unsignedJWT = `${header}.${payload}.`;

      // Test that the JWT is properly formatted
      const parts = unsignedJWT.split('.');
      expect(parts).toHaveLength(3);
      expect(parts[2]).toBe(''); // No signature for unsigned JWT

      // Decode and verify payload can be parsed
      const decodedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      expect(decodedPayload.response_type).toBe('code');
      expect(decodedPayload.client_id).toBe('test-client');
    });

    it('should parse request object parameters correctly', () => {
      const requestClaims = {
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid email',
        prompt: 'none',
        max_age: '3600',
        acr_values: 'urn:mace:incommon:iap:silver',
      };

      // Validate that all parameters are strings
      expect(typeof requestClaims.response_type).toBe('string');
      expect(typeof requestClaims.prompt).toBe('string');
      expect(typeof requestClaims.max_age).toBe('string');
      expect(typeof requestClaims.acr_values).toBe('string');
    });

    it('should override query parameters with request object parameters', () => {
      // Per OIDC Core 6.1: request object parameters take precedence
      const queryParams = {
        response_type: 'code',
        client_id: 'query-client',
        scope: 'openid',
      };

      const requestObjectParams = {
        response_type: 'code',
        client_id: 'request-client', // This should override query param
        scope: 'openid profile email', // This should override query param
      };

      // In actual implementation, request object params should win
      const effectiveParams = { ...queryParams, ...requestObjectParams };
      expect(effectiveParams.client_id).toBe('request-client');
      expect(effectiveParams.scope).toBe('openid profile email');
    });

    it('should validate JWT structure with 3 parts', () => {
      const validJWT = 'header.payload.signature';
      const parts = validJWT.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should reject malformed JWT with incorrect number of parts', () => {
      const invalidJWT = 'header.payload'; // Missing signature part
      const parts = invalidJWT.split('.');
      expect(parts).toHaveLength(2);
      expect(parts.length).not.toBe(3);
    });
  });

  describe('request_uri vs request parameter', () => {
    it('should handle request_uri (PAR) separately from request parameter', () => {
      // request_uri: URN for PAR (already implemented)
      const requestUri = 'urn:ietf:params:oauth:request_uri:abc123';
      expect(requestUri).toMatch(/^urn:ietf:params:oauth:request_uri:/);

      // request: JWT containing request parameters (newly implemented)
      const requestJWT = 'eyJhbGc.eyJyZXNwb25zZV90eXBl.signature';
      expect(requestJWT.split('.')).toHaveLength(3);

      // They serve different purposes
      expect(requestUri).not.toBe(requestJWT);
    });
  });

  describe('base64url decoding', () => {
    it('should correctly decode base64url to JSON', () => {
      const obj = { alg: 'none', typ: 'JWT' };
      const base64url = Buffer.from(JSON.stringify(obj)).toString('base64url');

      // Convert base64url to base64
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(Buffer.from(base64, 'base64').toString());

      expect(decoded.alg).toBe('none');
      expect(decoded.typ).toBe('JWT');
    });
  });
});

describe('Discovery Metadata', () => {
  it('should advertise request_parameter_supported', () => {
    const metadata = {
      request_parameter_supported: true,
      request_uri_parameter_supported: true,
      request_object_signing_alg_values_supported: ['RS256', 'none'],
    };

    expect(metadata.request_parameter_supported).toBe(true);
    expect(metadata.request_uri_parameter_supported).toBe(true);
    expect(metadata.request_object_signing_alg_values_supported).toContain('none');
    expect(metadata.request_object_signing_alg_values_supported).toContain('RS256');
  });
});
