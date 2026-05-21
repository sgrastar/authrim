/**
 * Discovery Profile Tests
 *
 * Tests for AI Ephemeral Auth profile-aware discovery metadata
 * and RFC 9396 RAR authorization_details_types_supported
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { clearDiscoveryMetadataCache, discoveryHandler } from '../discovery';
import type { Env } from '@authrim/ar-lib-core/types/env';
import type { OIDCProviderMetadata } from '@authrim/ar-lib-core/types/oidc';

/**
 * Create a mock environment for testing
 */
function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
    PRIVATE_KEY_PEM: 'test-key',
    KEY_ID: 'test-kid',
  } as Env;
}

describe('Discovery Profile Tests', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    clearDiscoveryMetadataCache();
    app = new Hono<{ Bindings: Env }>();
    app.get('/.well-known/openid-configuration', discoveryHandler);
  });

  describe('AI Scopes Feature Flag', () => {
    it('should not include AI scopes by default', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      expect(metadata.scopes_supported).toContain('openid');
      expect(metadata.scopes_supported).toContain('profile');
      expect(metadata.scopes_supported).toContain('email');
      expect(metadata.scopes_supported).not.toContain('ai:read');
      expect(metadata.scopes_supported).not.toContain('ai:write');
      expect(metadata.scopes_supported).not.toContain('ai:execute');
      expect(metadata.scopes_supported).not.toContain('ai:admin');
    });

    it('should include AI scopes when ENABLE_AI_SCOPES env is true', async () => {
      const env = createMockEnv();
      env.ENABLE_AI_SCOPES = 'true';

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      expect(metadata.scopes_supported).toContain('openid');
      expect(metadata.scopes_supported).toContain('ai:read');
      expect(metadata.scopes_supported).toContain('ai:write');
      expect(metadata.scopes_supported).toContain('ai:execute');
      expect(metadata.scopes_supported).toContain('ai:admin');
    });

    it('should include AI scopes when enabled via KV settings', async () => {
      const env = createMockEnv();
      env.SETTINGS = {
        get: async (key: string) => {
          if (key === 'system_settings') {
            return JSON.stringify({
              oidc: {
                aiScopes: { enabled: true },
              },
            });
          }
          return null;
        },
      } as unknown as KVNamespace;

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      expect(metadata.scopes_supported).toContain('ai:read');
      expect(metadata.scopes_supported).toContain('ai:write');
      expect(metadata.scopes_supported).toContain('ai:execute');
      expect(metadata.scopes_supported).toContain('ai:admin');
    });

    it('should prioritize KV setting over env variable for AI scopes', async () => {
      const env = createMockEnv();
      env.ENABLE_AI_SCOPES = 'true'; // env says enabled
      env.SETTINGS = {
        get: async (key: string) => {
          if (key === 'system_settings') {
            return JSON.stringify({
              oidc: {
                aiScopes: { enabled: false }, // KV says disabled
              },
            });
          }
          return null;
        },
      } as unknown as KVNamespace;

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      // KV takes precedence - AI scopes should NOT be included
      expect(metadata.scopes_supported).not.toContain('ai:read');
    });
  });

  describe('RFC 9396 RAR Feature Flag', () => {
    it('should not include authorization_details_types_supported by default', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      expect(metadata.authorization_details_types_supported).toBeUndefined();
    });

    it('should include authorization_details_types_supported when ENABLE_RAR env is true', async () => {
      const env = createMockEnv();
      env.ENABLE_RAR = 'true';

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      expect(metadata.authorization_details_types_supported).toBeDefined();
      expect(metadata.authorization_details_types_supported).toContain('ai_agent_action');
      expect(metadata.authorization_details_types_supported).toContain('payment_initiation');
      expect(metadata.authorization_details_types_supported).toContain('account_information');
    });

    it('should include authorization_details_types_supported when enabled via KV', async () => {
      const env = createMockEnv();
      env.SETTINGS = {
        get: async (key: string) => {
          if (key === 'system_settings') {
            return JSON.stringify({
              oidc: {
                rar: { enabled: true },
              },
            });
          }
          return null;
        },
      } as unknown as KVNamespace;

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      expect(metadata.authorization_details_types_supported).toBeDefined();
      expect(metadata.authorization_details_types_supported).toContain('ai_agent_action');
    });

    it('should prioritize KV setting over env variable for RAR', async () => {
      const env = createMockEnv();
      env.ENABLE_RAR = 'true'; // env says enabled
      env.SETTINGS = {
        get: async (key: string) => {
          if (key === 'system_settings') {
            return JSON.stringify({
              oidc: {
                rar: { enabled: false }, // KV says disabled
              },
            });
          }
          return null;
        },
      } as unknown as KVNamespace;

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      // KV takes precedence - RAR should NOT be included
      expect(metadata.authorization_details_types_supported).toBeUndefined();
    });
  });

  describe('Combined Feature Flags', () => {
    it('should support both AI scopes and RAR enabled together', async () => {
      const env = createMockEnv();
      env.ENABLE_AI_SCOPES = 'true';
      env.ENABLE_RAR = 'true';

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      // AI scopes included
      expect(metadata.scopes_supported).toContain('ai:read');
      expect(metadata.scopes_supported).toContain('ai:write');

      // RAR types included
      expect(metadata.authorization_details_types_supported).toContain('ai_agent_action');
      expect(metadata.authorization_details_types_supported).toContain('payment_initiation');
    });

    it('should include ai_agent_action in RAR types regardless of AI scopes setting', async () => {
      const env = createMockEnv();
      env.ENABLE_AI_SCOPES = 'false'; // AI scopes disabled
      env.ENABLE_RAR = 'true'; // RAR enabled

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      // AI scopes NOT included
      expect(metadata.scopes_supported).not.toContain('ai:read');

      // But ai_agent_action IS included in RAR types
      expect(metadata.authorization_details_types_supported).toContain('ai_agent_action');
    });
  });

  describe('Cache Key Generation', () => {
    it('should cache different metadata for different feature flag combinations', async () => {
      const env1 = createMockEnv();
      env1.ENABLE_RAR = 'true';

      const env2 = createMockEnv();
      env2.ENABLE_RAR = 'false';

      // First request with RAR enabled
      const response1 = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env1
      );
      const metadata1 = (await response1.json()) as OIDCProviderMetadata;

      // Second request with RAR disabled
      const response2 = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env2
      );
      const metadata2 = (await response2.json()) as OIDCProviderMetadata;

      // Should have different metadata
      expect(metadata1.authorization_details_types_supported).toBeDefined();
      expect(metadata2.authorization_details_types_supported).toBeUndefined();
    });
  });
});
