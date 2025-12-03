/**
 * OIDCRPClient Unit Tests
 * Tests the actual OIDCRPClient implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OIDCRPClient } from '../clients/oidc-client';
import type { UpstreamProvider } from '../types';

// Mock fetch globally
const mockFetch = vi.fn();

describe('OIDCRPClient', () => {
  const mockDiscoveryDoc = {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  };

  const mockProvider: UpstreamProvider = {
    id: 'test-provider-id',
    tenantId: 'default',
    name: 'Google',
    providerType: 'oidc',
    enabled: true,
    priority: 0,
    issuer: 'https://accounts.google.com',
    clientId: 'test-client-id',
    clientSecretEncrypted: 'test-client-secret',
    scopes: 'openid email profile',
    attributeMapping: {},
    autoLinkEmail: true,
    jitProvisioning: true,
    requireEmailVerified: true,
    providerQuirks: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const mockConfig = {
    issuer: 'https://accounts.google.com',
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    redirectUri: 'https://example.com/callback',
    scopes: ['openid', 'email', 'profile'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('should create client with config', () => {
      const client = new OIDCRPClient(mockConfig);
      expect(client).toBeInstanceOf(OIDCRPClient);
    });
  });

  describe('fromProvider', () => {
    it('should create client from UpstreamProvider', () => {
      const client = OIDCRPClient.fromProvider(
        mockProvider,
        'https://example.com/callback',
        'decrypted-secret'
      );

      expect(client).toBeInstanceOf(OIDCRPClient);
    });

    it('should parse space-separated scopes', () => {
      const providerWithSpaces = { ...mockProvider, scopes: 'openid email profile' };
      const client = OIDCRPClient.fromProvider(
        providerWithSpaces,
        'https://example.com/callback',
        'secret'
      );

      expect(client).toBeInstanceOf(OIDCRPClient);
    });

    it('should parse comma-separated scopes', () => {
      const providerWithCommas = { ...mockProvider, scopes: 'openid,email,profile' };
      const client = OIDCRPClient.fromProvider(
        providerWithCommas,
        'https://example.com/callback',
        'secret'
      );

      expect(client).toBeInstanceOf(OIDCRPClient);
    });
  });

  describe('discover', () => {
    it('should fetch and cache discovery document', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      const client = new OIDCRPClient(mockConfig);
      const metadata = await client.discover();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://accounts.google.com/.well-known/openid-configuration'
      );
      expect(metadata.authorization_endpoint).toBe(mockDiscoveryDoc.authorization_endpoint);
      expect(metadata.token_endpoint).toBe(mockDiscoveryDoc.token_endpoint);
    });

    it('should use cached metadata on subsequent calls', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      const client = new OIDCRPClient(mockConfig);

      // First call - should fetch
      await client.discover();
      // Second call - should use cache
      await client.discover();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw error on HTTP failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const client = new OIDCRPClient(mockConfig);

      await expect(client.discover()).rejects.toThrow(
        'Failed to fetch OIDC discovery document: 404'
      );
    });
  });

  describe('createAuthorizationUrl', () => {
    it('should generate valid authorization URL with PKCE', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      const client = new OIDCRPClient(mockConfig);
      const url = await client.createAuthorizationUrl({
        state: 'test-state',
        nonce: 'test-nonce',
        codeVerifier: 'test-verifier-1234567890123456789012345678901234567890',
      });

      expect(url).toContain(mockDiscoveryDoc.authorization_endpoint);
      expect(url).toContain('response_type=code');
      expect(url).toContain(`client_id=${mockConfig.clientId}`);
      expect(url).toContain(`redirect_uri=${encodeURIComponent(mockConfig.redirectUri)}`);
      expect(url).toContain('state=test-state');
      expect(url).toContain('nonce=test-nonce');
      expect(url).toContain('code_challenge=');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('should include optional prompt parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      const client = new OIDCRPClient(mockConfig);
      const url = await client.createAuthorizationUrl({
        state: 'test-state',
        nonce: 'test-nonce',
        codeVerifier: 'test-verifier-1234567890123456789012345678901234567890',
        prompt: 'consent',
      });

      expect(url).toContain('prompt=consent');
    });

    it('should include optional login_hint parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      const client = new OIDCRPClient(mockConfig);
      const url = await client.createAuthorizationUrl({
        state: 'test-state',
        nonce: 'test-nonce',
        codeVerifier: 'test-verifier-1234567890123456789012345678901234567890',
        loginHint: 'user@example.com',
      });

      expect(url).toContain('login_hint=user%40example.com');
    });

    it('should use explicit endpoint if configured', async () => {
      const configWithEndpoint = {
        ...mockConfig,
        authorizationEndpoint: 'https://custom.auth/authorize',
      };

      const client = new OIDCRPClient(configWithEndpoint);
      const url = await client.createAuthorizationUrl({
        state: 'test-state',
        nonce: 'test-nonce',
        codeVerifier: 'test-verifier-1234567890123456789012345678901234567890',
      });

      expect(url).toContain('https://custom.auth/authorize');
      // Should not call discovery
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('handleCallback', () => {
    it('should exchange code for tokens', async () => {
      const mockTokenResponse = {
        access_token: 'mock-access-token',
        id_token: 'mock-id-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token',
      };

      // Mock discovery
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      });

      const client = new OIDCRPClient(mockConfig);
      const tokens = await client.handleCallback('auth-code-123', 'verifier-456');

      expect(tokens.access_token).toBe('mock-access-token');
      expect(tokens.id_token).toBe('mock-id-token');
      expect(tokens.refresh_token).toBe('mock-refresh-token');

      // Verify token request
      const tokenCall = mockFetch.mock.calls[1];
      expect(tokenCall[0]).toBe(mockDiscoveryDoc.token_endpoint);
      expect(tokenCall[1].method).toBe('POST');
      expect(tokenCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const body = tokenCall[1].body;
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=auth-code-123');
      expect(body).toContain('code_verifier=verifier-456');
    });

    it('should throw error on token exchange failure', async () => {
      // Mock discovery
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      // Mock failed token exchange
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      });

      const client = new OIDCRPClient(mockConfig);

      await expect(client.handleCallback('invalid-code', 'verifier')).rejects.toThrow(
        'Token exchange failed: 400 - invalid_grant'
      );
    });

    it('should use explicit token endpoint if configured', async () => {
      const configWithEndpoint = {
        ...mockConfig,
        tokenEndpoint: 'https://custom.auth/token',
      };

      const mockTokenResponse = {
        access_token: 'mock-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      });

      const client = new OIDCRPClient(configWithEndpoint);
      await client.handleCallback('code', 'verifier');

      expect(mockFetch).toHaveBeenCalledWith('https://custom.auth/token', expect.any(Object));
    });
  });

  describe('fetchUserInfo', () => {
    it('should fetch user info with bearer token', async () => {
      const mockUserInfo = {
        sub: 'user-123',
        email: 'user@example.com',
        email_verified: true,
        name: 'Test User',
      };

      // Mock discovery
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      // Mock userinfo
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockUserInfo,
      });

      const client = new OIDCRPClient(mockConfig);
      const userInfo = await client.fetchUserInfo('access-token-123');

      expect(userInfo.sub).toBe('user-123');
      expect(userInfo.email).toBe('user@example.com');
      expect(userInfo.email_verified).toBe(true);

      // Verify Authorization header
      const userinfoCall = mockFetch.mock.calls[1];
      expect(userinfoCall[1].headers.Authorization).toBe('Bearer access-token-123');
    });

    it('should throw error when userinfo endpoint not available', async () => {
      const discoveryWithoutUserinfo = {
        ...mockDiscoveryDoc,
        userinfo_endpoint: undefined,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => discoveryWithoutUserinfo,
      });

      const client = new OIDCRPClient(mockConfig);

      await expect(client.fetchUserInfo('token')).rejects.toThrow(
        'Userinfo endpoint not available'
      );
    });

    it('should throw error on userinfo request failure', async () => {
      // Mock discovery
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      // Mock failed userinfo
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const client = new OIDCRPClient(mockConfig);

      await expect(client.fetchUserInfo('invalid-token')).rejects.toThrow(
        'Userinfo request failed: 401'
      );
    });
  });

  describe('refreshTokens', () => {
    it('should refresh tokens with refresh_token grant', async () => {
      const mockRefreshResponse = {
        access_token: 'new-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      };

      // Mock discovery
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      // Mock refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockRefreshResponse,
      });

      const client = new OIDCRPClient(mockConfig);
      const tokens = await client.refreshTokens('old-refresh-token');

      expect(tokens.access_token).toBe('new-access-token');

      // Verify refresh request
      const refreshCall = mockFetch.mock.calls[1];
      expect(refreshCall[1].method).toBe('POST');

      const body = refreshCall[1].body;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=old-refresh-token');
    });

    it('should throw error on refresh failure', async () => {
      // Mock discovery
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoveryDoc,
      });

      // Mock failed refresh
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      });

      const client = new OIDCRPClient(mockConfig);

      await expect(client.refreshTokens('expired-token')).rejects.toThrow(
        'Token refresh failed: 400 - invalid_grant'
      );
    });
  });

  describe('endpoint configuration', () => {
    it('should prefer explicit endpoints over discovery', async () => {
      const configWithAllEndpoints = {
        ...mockConfig,
        authorizationEndpoint: 'https://custom/authorize',
        tokenEndpoint: 'https://custom/token',
        userinfoEndpoint: 'https://custom/userinfo',
      };

      const client = new OIDCRPClient(configWithAllEndpoints);

      // Auth URL should use custom endpoint
      const authUrl = await client.createAuthorizationUrl({
        state: 'state',
        nonce: 'nonce',
        codeVerifier: 'verifier-123456789012345678901234567890123456',
      });
      expect(authUrl).toContain('https://custom/authorize');

      // Mock token response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token', token_type: 'Bearer' }),
      });

      await client.handleCallback('code', 'verifier');
      expect(mockFetch).toHaveBeenCalledWith('https://custom/token', expect.any(Object));

      // Mock userinfo response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sub: 'user-123' }),
      });

      await client.fetchUserInfo('token');
      expect(mockFetch).toHaveBeenCalledWith('https://custom/userinfo', expect.any(Object));

      // Discovery should never have been called
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('.well-known/openid-configuration')
      );
    });
  });
});
