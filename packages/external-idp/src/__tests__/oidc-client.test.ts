/**
 * OIDCRPClient Unit Tests
 * Tests the actual OIDCRPClient implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OIDCRPClient } from '../clients/oidc-client';
import type { UpstreamProvider } from '../types';

// Mock jose module for ID token validation tests
const mockJwtVerify = vi.fn();
const mockCreateLocalJWKSet = vi.fn();

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
    createLocalJWKSet: (...args: unknown[]) => mockCreateLocalJWKSet(...args),
  };
});

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
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
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
        'Token exchange failed: HTTP 400'
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
        'Token refresh failed: HTTP 400'
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

  describe('Microsoft multi-tenant issuer validation', () => {
    const microsoftDiscoveryDoc = {
      issuer: 'https://login.microsoftonline.com/common/v2.0',
      authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo',
      jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
      response_types_supported: ['code'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
    };

    const microsoftConfig = {
      issuer: 'https://login.microsoftonline.com/common/v2.0',
      clientId: 'test-microsoft-client-id',
      clientSecret: 'test-microsoft-secret',
      redirectUri: 'https://example.com/callback',
      scopes: ['openid', 'email', 'profile'],
      providerQuirks: { tenantType: 'common' },
    };

    const createMicrosoftProvider = (tenantType: string): UpstreamProvider => ({
      id: 'microsoft-provider-id',
      tenantId: 'default',
      name: 'Microsoft',
      providerType: 'oidc',
      enabled: true,
      priority: 0,
      issuer: `https://login.microsoftonline.com/${tenantType}/v2.0`,
      clientId: 'test-microsoft-client-id',
      clientSecretEncrypted: 'encrypted-secret',
      scopes: 'openid email profile',
      attributeMapping: {},
      autoLinkEmail: true,
      jitProvisioning: true,
      requireEmailVerified: true,
      providerQuirks: { tenantType },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    it('should create client from Microsoft provider with tenantType quirk', () => {
      const provider = createMicrosoftProvider('common');
      const client = OIDCRPClient.fromProvider(
        provider,
        'https://example.com/callback',
        'decrypted-secret'
      );

      expect(client).toBeInstanceOf(OIDCRPClient);
    });

    it('should create client from Microsoft provider with organizations tenantType', () => {
      const provider = createMicrosoftProvider('organizations');
      const client = OIDCRPClient.fromProvider(
        provider,
        'https://example.com/callback',
        'decrypted-secret'
      );

      expect(client).toBeInstanceOf(OIDCRPClient);
    });

    it('should create client from Microsoft provider with consumers tenantType', () => {
      const provider = createMicrosoftProvider('consumers');
      const client = OIDCRPClient.fromProvider(
        provider,
        'https://example.com/callback',
        'decrypted-secret'
      );

      expect(client).toBeInstanceOf(OIDCRPClient);
    });

    it('should create client from Microsoft provider with specific tenant GUID', () => {
      const provider = createMicrosoftProvider('12345678-1234-1234-1234-123456789012');
      const client = OIDCRPClient.fromProvider(
        provider,
        'https://example.com/callback',
        'decrypted-secret'
      );

      expect(client).toBeInstanceOf(OIDCRPClient);
    });

    it('should generate valid Microsoft authorization URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => microsoftDiscoveryDoc,
      });

      const client = new OIDCRPClient(microsoftConfig);
      const url = await client.createAuthorizationUrl({
        state: 'test-state',
        nonce: 'test-nonce',
        codeVerifier: 'test-verifier-1234567890123456789012345678901234567890',
      });

      expect(url).toContain('login.microsoftonline.com');
      expect(url).toContain('response_type=code');
      expect(url).toContain('code_challenge=');
      expect(url).toContain('code_challenge_method=S256');
    });
  });

  // Shared test helpers for ID token validation tests
  const mockJwks = {
    keys: [
      {
        kty: 'RSA',
        kid: 'test-key-id',
        n: 'test-n',
        e: 'AQAB',
      },
    ],
  };

  const createMockPayload = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: 'https://accounts.google.com',
      sub: 'user-123',
      aud: 'test-client-id',
      exp: now + 3600,
      iat: now - 60,
      nonce: 'test-nonce',
      email: 'user@example.com',
      email_verified: true,
      name: 'Test User',
      ...overrides,
    };
  };

  describe('validateIdToken', () => {
    const now = Math.floor(Date.now() / 1000);

    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should validate Google ID token successfully', async () => {
      // Mock JWKS fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockJwks,
      });

      const mockPayload = createMockPayload();

      // Mock jose functions
      mockJwtVerify.mockResolvedValueOnce({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
      });
      mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

      const client = new OIDCRPClient({
        issuer: 'https://accounts.google.com',
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        scopes: ['openid', 'email', 'profile'],
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      });

      const userInfo = await client.validateIdToken('mock-id-token', 'test-nonce');

      expect(userInfo.sub).toBe('user-123');
      expect(userInfo.email).toBe('user@example.com');
      expect(userInfo.email_verified).toBe(true);
    });

    it('should reject ID token with nonce mismatch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockJwks,
      });

      const mockPayload = createMockPayload({ nonce: 'different-nonce' });

      mockJwtVerify.mockResolvedValueOnce({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
      });
      mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

      const client = new OIDCRPClient({
        issuer: 'https://accounts.google.com',
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        scopes: ['openid'],
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      });

      await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
        'nonce mismatch'
      );
    });

    it('should reject expired ID token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockJwks,
      });

      const mockPayload = createMockPayload({
        nonce: 'test-nonce',
        exp: now - 3600, // Expired 1 hour ago
      });

      mockJwtVerify.mockResolvedValueOnce({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
      });
      mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

      const client = new OIDCRPClient({
        issuer: 'https://accounts.google.com',
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        scopes: ['openid'],
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      });

      await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
        'expired'
      );
    });

    it('should reject ID token issued in the future', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockJwks,
      });

      const mockPayload = createMockPayload({
        nonce: 'test-nonce',
        iat: now + 3600, // Issued 1 hour in the future (beyond 60s clock skew)
      });

      mockJwtVerify.mockResolvedValueOnce({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
      });
      mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

      const client = new OIDCRPClient({
        issuer: 'https://accounts.google.com',
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        scopes: ['openid'],
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      });

      await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
        'issued in the future'
      );
    });

    describe('Microsoft multi-tenant issuer validation', () => {
      it('should accept valid Microsoft issuer with tenant-specific GUID', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockJwks,
        });

        // Microsoft returns a tenant-specific issuer in the token
        const mockPayload = createMockPayload({
          iss: 'https://login.microsoftonline.com/12345678-1234-1234-1234-123456789012/v2.0',
          aud: 'microsoft-client-id',
          nonce: 'test-nonce',
        });

        mockJwtVerify.mockResolvedValueOnce({
          payload: mockPayload,
          protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
        });
        mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

        // Client configured with "common" endpoint
        const client = new OIDCRPClient({
          issuer: 'https://login.microsoftonline.com/common/v2.0',
          clientId: 'microsoft-client-id',
          clientSecret: 'test-secret',
          redirectUri: 'https://example.com/callback',
          scopes: ['openid'],
          jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
          providerQuirks: { tenantType: 'common' },
        });

        const userInfo = await client.validateIdToken('mock-id-token', 'test-nonce');
        expect(userInfo.sub).toBe('user-123');
      });

      it('should accept valid Microsoft issuer with organizations tenantType', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockJwks,
        });

        const mockPayload = createMockPayload({
          iss: 'https://login.microsoftonline.com/abcdef01-1234-1234-1234-123456789012/v2.0',
          aud: 'microsoft-client-id',
          nonce: 'test-nonce',
        });

        mockJwtVerify.mockResolvedValueOnce({
          payload: mockPayload,
          protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
        });
        mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

        const client = new OIDCRPClient({
          issuer: 'https://login.microsoftonline.com/organizations/v2.0',
          clientId: 'microsoft-client-id',
          clientSecret: 'test-secret',
          redirectUri: 'https://example.com/callback',
          scopes: ['openid'],
          jwksUri: 'https://login.microsoftonline.com/organizations/discovery/v2.0/keys',
          providerQuirks: { tenantType: 'organizations' },
        });

        const userInfo = await client.validateIdToken('mock-id-token', 'test-nonce');
        expect(userInfo.sub).toBe('user-123');
      });

      it('should reject invalid Microsoft issuer (non-Microsoft domain)', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockJwks,
        });

        // Attacker tries to use a fake issuer
        const mockPayload = createMockPayload({
          iss: 'https://evil.com/12345678-1234-1234-1234-123456789012/v2.0',
          aud: 'microsoft-client-id',
          nonce: 'test-nonce',
        });

        mockJwtVerify.mockResolvedValueOnce({
          payload: mockPayload,
          protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
        });
        mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

        const client = new OIDCRPClient({
          issuer: 'https://login.microsoftonline.com/common/v2.0',
          clientId: 'microsoft-client-id',
          clientSecret: 'test-secret',
          redirectUri: 'https://example.com/callback',
          scopes: ['openid'],
          jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
          providerQuirks: { tenantType: 'common' },
        });

        await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
          'Invalid Microsoft issuer'
        );
      });

      it('should reject Microsoft issuer with subdomain attack', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockJwks,
        });

        // Attacker tries subdomain attack
        const mockPayload = createMockPayload({
          iss: 'https://evil.login.microsoftonline.com/12345678-1234-1234-1234-123456789012/v2.0',
          aud: 'microsoft-client-id',
          nonce: 'test-nonce',
        });

        mockJwtVerify.mockResolvedValueOnce({
          payload: mockPayload,
          protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
        });
        mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

        const client = new OIDCRPClient({
          issuer: 'https://login.microsoftonline.com/common/v2.0',
          clientId: 'microsoft-client-id',
          clientSecret: 'test-secret',
          redirectUri: 'https://example.com/callback',
          scopes: ['openid'],
          jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
          providerQuirks: { tenantType: 'common' },
        });

        await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
          'Invalid Microsoft issuer'
        );
      });

      it('should reject Microsoft issuer with missing issuer claim', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockJwks,
        });

        const mockPayload = createMockPayload({
          iss: undefined, // Missing issuer
          aud: 'microsoft-client-id',
          nonce: 'test-nonce',
        });

        mockJwtVerify.mockResolvedValueOnce({
          payload: mockPayload,
          protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
        });
        mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

        const client = new OIDCRPClient({
          issuer: 'https://login.microsoftonline.com/common/v2.0',
          clientId: 'microsoft-client-id',
          clientSecret: 'test-secret',
          redirectUri: 'https://example.com/callback',
          scopes: ['openid'],
          jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
          providerQuirks: { tenantType: 'common' },
        });

        await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
          'Missing issuer claim'
        );
      });

      it('should use standard issuer validation for specific tenant (not common/organizations/consumers)', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockJwks,
        });

        const tenantId = '12345678-1234-1234-1234-123456789012';
        const mockPayload = createMockPayload({
          iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
          aud: 'microsoft-client-id',
          nonce: 'test-nonce',
        });

        mockJwtVerify.mockResolvedValueOnce({
          payload: mockPayload,
          protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
        });
        mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

        // When a specific tenant ID is used, standard issuer validation should apply
        const client = new OIDCRPClient({
          issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
          clientId: 'microsoft-client-id',
          clientSecret: 'test-secret',
          redirectUri: 'https://example.com/callback',
          scopes: ['openid'],
          jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
          providerQuirks: { tenantType: tenantId }, // Specific tenant, not common/organizations/consumers
        });

        const userInfo = await client.validateIdToken('mock-id-token', 'test-nonce');
        expect(userInfo.sub).toBe('user-123');
      });
    });

    // ============================================================================
    // OIDC Core 1.0 Compliance Tests
    // ============================================================================

    describe('OIDC Core 1.0 Compliance', () => {
      // Helper function to compute at_hash / c_hash per OIDC spec
      // OIDC Core 3.3.2.11: left half of SHA hash, base64url encoded
      async function computeTokenHash(tokenValue: string, alg: string): Promise<string> {
        // Determine hash algorithm based on signing algorithm
        const hashAlg = alg.includes('384')
          ? 'SHA-384'
          : alg.includes('512')
            ? 'SHA-512'
            : 'SHA-256';

        const encoder = new TextEncoder();
        const data = encoder.encode(tokenValue);
        const hashBuffer = await crypto.subtle.digest(hashAlg, data);

        // Take left-most half
        const hashArray = new Uint8Array(hashBuffer);
        const leftHalf = hashArray.slice(0, hashArray.length / 2);

        // Base64url encode
        const base64 = btoa(String.fromCharCode(...leftHalf));
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }

      describe('at_hash validation (OIDC Core 3.3.2.11)', () => {
        it('should validate correct at_hash for access token', async () => {
          const accessToken = 'SlAV32hkKG';
          const atHash = await computeTokenHash(accessToken, 'RS256');

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            at_hash: atHash,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
            accessToken: accessToken,
          });

          expect(userInfo.sub).toBe('user-123');
        });

        it('should reject invalid at_hash for access token', async () => {
          const accessToken = 'SlAV32hkKG';
          const wrongAtHash = 'wronghash123456789012345678901234567890';

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            at_hash: wrongAtHash,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          await expect(
            client.validateIdToken('mock-id-token', {
              nonce: 'test-nonce',
              accessToken: accessToken,
            })
          ).rejects.toThrow('at_hash validation failed');
        });

        it('should skip at_hash validation when access token not provided', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            at_hash: 'some_hash_that_would_fail',
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          // Should succeed because accessToken is not provided
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
          });
          expect(userInfo.sub).toBe('user-123');
        });

        it('should use SHA-384 for RS384 algorithm', async () => {
          const accessToken = 'test-access-token-384';
          const atHash = await computeTokenHash(accessToken, 'RS384');

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            at_hash: atHash,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS384', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
            accessToken: accessToken,
          });
          expect(userInfo.sub).toBe('user-123');
        });

        it('should use SHA-512 for RS512 algorithm', async () => {
          const accessToken = 'test-access-token-512';
          const atHash = await computeTokenHash(accessToken, 'RS512');

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            at_hash: atHash,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS512', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
            accessToken: accessToken,
          });
          expect(userInfo.sub).toBe('user-123');
        });
      });

      describe('c_hash validation (OIDC Core 3.3.2.12)', () => {
        it('should validate correct c_hash for authorization code', async () => {
          const code = 'Qcb0Orv1zh30vL1MPRsbm-diHiMwcLyZvn1arpZv-Jxf_11jnpEX3Tgfvk';
          const cHash = await computeTokenHash(code, 'RS256');

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            c_hash: cHash,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
            code: code,
          });

          expect(userInfo.sub).toBe('user-123');
        });

        it('should reject invalid c_hash for authorization code', async () => {
          const code = 'Qcb0Orv1zh30vL1MPRsbm-diHiMwcLyZvn1arpZv-Jxf_11jnpEX3Tgfvk';
          const wrongCHash = 'wronghash_for_code_test_12345678901234';

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            c_hash: wrongCHash,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          await expect(
            client.validateIdToken('mock-id-token', {
              nonce: 'test-nonce',
              code: code,
            })
          ).rejects.toThrow('c_hash validation failed');
        });

        it('should skip c_hash validation when code not provided', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            c_hash: 'some_hash_that_would_fail',
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          // Should succeed because code is not provided
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
          });
          expect(userInfo.sub).toBe('user-123');
        });
      });

      describe('azp validation (OIDC Core 3.1.3.7 steps 5-6)', () => {
        it('should accept valid azp matching client_id', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            azp: 'test-client-id', // Same as client_id
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', { nonce: 'test-nonce' });
          expect(userInfo.sub).toBe('user-123');
        });

        it('should reject azp not matching client_id', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            azp: 'different-client-id', // Different from client_id
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          await expect(
            client.validateIdToken('mock-id-token', { nonce: 'test-nonce' })
          ).rejects.toThrow('azp (different-client-id) does not match client_id (test-client-id)');
        });

        it('should accept multiple audiences with valid azp', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: ['test-client-id', 'other-audience'],
            nonce: 'test-nonce',
            azp: 'test-client-id',
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', { nonce: 'test-nonce' });
          expect(userInfo.sub).toBe('user-123');
        });

        it('should accept token without azp when single audience', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            // No azp claim - valid for single audience
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', { nonce: 'test-nonce' });
          expect(userInfo.sub).toBe('user-123');
        });
      });

      describe('auth_time validation (OIDC Core 3.1.3.7 step 11)', () => {
        it('should accept valid auth_time within max_age', async () => {
          const now = Math.floor(Date.now() / 1000);
          const authTime = now - 30; // Authenticated 30 seconds ago

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            auth_time: authTime,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
            maxAge: 300, // 5 minutes max_age
          });
          expect(userInfo.sub).toBe('user-123');
        });

        it('should reject when auth_time exceeds max_age', async () => {
          const now = Math.floor(Date.now() / 1000);
          const authTime = now - 400; // Authenticated 400 seconds ago

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            auth_time: authTime,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          await expect(
            client.validateIdToken('mock-id-token', {
              nonce: 'test-nonce',
              maxAge: 300, // max_age is 300 seconds but auth was 400 seconds ago
            })
          ).rejects.toThrow('Authentication is too old');
        });

        it('should require auth_time when max_age is specified', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            // No auth_time claim
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          await expect(
            client.validateIdToken('mock-id-token', {
              nonce: 'test-nonce',
              maxAge: 300,
            })
          ).rejects.toThrow('missing auth_time claim (required when max_age is requested)');
        });

        it('should skip auth_time validation when max_age not specified', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            // No auth_time, no max_age - should be OK
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
            // No maxAge
          });
          expect(userInfo.sub).toBe('user-123');
        });

        it('should allow clock skew tolerance in auth_time validation', async () => {
          const now = Math.floor(Date.now() / 1000);
          // Auth was 350 seconds ago, max_age is 300
          // But with 60 second clock skew tolerance, this should pass
          const authTime = now - 350;

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            auth_time: authTime,
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          // 350 seconds old, max_age 300, but with 60s tolerance should pass
          const userInfo = await client.validateIdToken('mock-id-token', {
            nonce: 'test-nonce',
            maxAge: 300,
          });
          expect(userInfo.sub).toBe('user-123');
        });
      });

      describe('JWKS refresh on signature failure', () => {
        it('should retry with fresh JWKS when signature verification fails', async () => {
          // First JWKS fetch
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });
          // Second JWKS fetch after refresh
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
          });

          // First attempt fails with signature error
          mockJwtVerify.mockRejectedValueOnce(new Error('JWS signature verification failed'));

          // Second attempt succeeds
          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });

          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', 'test-nonce');

          expect(userInfo.sub).toBe('user-123');
          expect(mockFetch).toHaveBeenCalledTimes(2); // JWKS fetched twice
          expect(mockJwtVerify).toHaveBeenCalledTimes(2); // Verification attempted twice
        });

        it('should retry with fresh JWKS on key not found error', async () => {
          // First JWKS fetch
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });
          // Second JWKS fetch after refresh
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
          });

          // First attempt fails with key error
          mockJwtVerify.mockRejectedValueOnce(
            new Error('no applicable key found in the JSON Web Key Set')
          );

          // Second attempt succeeds
          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });

          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', 'test-nonce');

          expect(userInfo.sub).toBe('user-123');
          expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('should not retry for non-signature errors (e.g., nonce mismatch)', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'different-nonce', // Wrong nonce
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
            'nonce mismatch'
          );

          // JWKS should only be fetched once (no retry for nonce errors)
          expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should propagate error if retry also fails', async () => {
          // First JWKS fetch
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });
          // Second JWKS fetch after refresh
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          // Both attempts fail with signature error
          mockJwtVerify.mockRejectedValueOnce(new Error('JWS signature verification failed'));
          mockJwtVerify.mockRejectedValueOnce(new Error('JWS signature verification failed'));

          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          await expect(client.validateIdToken('mock-id-token', 'test-nonce')).rejects.toThrow(
            'JWS signature verification failed'
          );

          expect(mockFetch).toHaveBeenCalledTimes(2);
          expect(mockJwtVerify).toHaveBeenCalledTimes(2);
        });
      });

      describe('auth_time, acr, amr extraction', () => {
        it('should extract auth_time, acr, and amr from ID token', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'test-nonce',
            auth_time: 1702000000,
            acr: 'urn:mace:incommon:iap:silver',
            amr: ['pwd', 'mfa'],
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          const userInfo = await client.validateIdToken('mock-id-token', { nonce: 'test-nonce' });

          expect(userInfo.auth_time).toBe(1702000000);
          expect(userInfo.acr).toBe('urn:mace:incommon:iap:silver');
          expect(userInfo.amr).toEqual(['pwd', 'mfa']);
        });
      });

      describe('Legacy signature compatibility', () => {
        it('should support legacy string nonce signature', async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockJwks,
          });

          const mockPayload = createMockPayload({
            iss: 'https://accounts.google.com',
            aud: 'test-client-id',
            nonce: 'legacy-nonce',
          });

          mockJwtVerify.mockResolvedValueOnce({
            payload: mockPayload,
            protectedHeader: { alg: 'RS256', kid: 'test-key-id' },
          });
          mockCreateLocalJWKSet.mockReturnValueOnce(() => {});

          const client = new OIDCRPClient(mockConfig);
          // Using legacy string signature
          const userInfo = await client.validateIdToken('mock-id-token', 'legacy-nonce');

          expect(userInfo.sub).toBe('user-123');
        });
      });
    });
  });
});
