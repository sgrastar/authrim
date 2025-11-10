/**
 * Test Fixtures for Integration Tests
 *
 * Provides common test data, mock clients, and helper functions
 * for integration testing of OIDC flows.
 */

import type { Env } from '../../src/types/env';

/**
 * Mock client configuration
 */
export interface MockClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
}

/**
 * Mock user data
 */
export interface MockUser {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  preferred_username: string;
}

/**
 * Test clients
 */
export const testClients: Record<string, MockClient> = {
  confidential: {
    client_id: 'test-client-confidential',
    client_secret: 'test-secret-123',
    redirect_uris: ['https://example.com/callback', 'http://localhost:3000/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid profile email',
  },
  public: {
    client_id: 'test-client-public',
    redirect_uris: ['https://example.com/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid profile',
  },
};

/**
 * Test users
 */
export const testUsers: Record<string, MockUser> = {
  john: {
    sub: 'user-john-123',
    email: 'john@example.com',
    email_verified: true,
    name: 'John Doe',
    preferred_username: 'johndoe',
  },
  jane: {
    sub: 'user-jane-456',
    email: 'jane@example.com',
    email_verified: true,
    name: 'Jane Smith',
    preferred_username: 'janesmith',
  },
};

/**
 * Create a mock Cloudflare environment for testing
 */
export function createMockEnv(): Env {
  // Mock KV namespace implementation
  class MockKVNamespace implements KVNamespace {
    private store: Map<string, { value: string; expiration?: number }> = new Map();

    async get(key: string): Promise<string | null> {
      const entry = this.store.get(key);
      if (!entry) return null;

      if (entry.expiration && Date.now() > entry.expiration) {
        this.store.delete(key);
        return null;
      }

      return entry.value;
    }

    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const expiration = options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : undefined;
      this.store.set(key, { value, expiration });
    }

    async delete(key: string): Promise<void> {
      this.store.delete(key);
    }

    async list(): Promise<any> {
      throw new Error('Not implemented');
    }

    async getWithMetadata(): Promise<any> {
      throw new Error('Not implemented');
    }
  }

  return {
    AUTH_CODES: new MockKVNamespace() as unknown as KVNamespace,
    STATE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    NONCE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    CLIENTS: new MockKVNamespace() as unknown as KVNamespace,
    ISSUER_URL: 'http://localhost:8787',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '120',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    KEY_ID: 'test-key-id',
  };
}

/**
 * Generate random state parameter
 */
export function generateState(): string {
  return `state-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Generate random nonce parameter
 */
export function generateNonce(): string {
  return `nonce-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Build authorization request URL
 */
export function buildAuthorizationUrl(params: {
  issuer: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  nonce?: string;
  response_type?: string;
}): string {
  const url = new URL(`${params.issuer}/authorize`);
  url.searchParams.set('client_id', params.client_id);
  url.searchParams.set('redirect_uri', params.redirect_uri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('response_type', params.response_type || 'code');

  if (params.state) {
    url.searchParams.set('state', params.state);
  }

  if (params.nonce) {
    url.searchParams.set('nonce', params.nonce);
  }

  return url.toString();
}

/**
 * Parse authorization response
 */
export function parseAuthorizationResponse(redirectUri: string): {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
} {
  const url = new URL(redirectUri);
  const params = url.searchParams;

  return {
    code: params.get('code') || undefined,
    state: params.get('state') || undefined,
    error: params.get('error') || undefined,
    error_description: params.get('error_description') || undefined,
  };
}

/**
 * Build token request body
 */
export function buildTokenRequestBody(params: {
  grant_type: string;
  code: string;
  client_id: string;
  redirect_uri: string;
  client_secret?: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set('grant_type', params.grant_type);
  body.set('code', params.code);
  body.set('client_id', params.client_id);
  body.set('redirect_uri', params.redirect_uri);

  if (params.client_secret) {
    body.set('client_secret', params.client_secret);
  }

  return body;
}

/**
 * Parse ID token claims (without verification)
 */
export function parseIdToken(idToken: string): any {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const payload = parts[1];
  const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
  return JSON.parse(decoded);
}

/**
 * Wait for a specified duration
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
