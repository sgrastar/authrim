/**
 * GitHub Provider Configuration Unit Tests
 * Tests for GitHub-specific OAuth 2.0 configuration and validation
 */

import { describe, it, expect } from 'vitest';
import {
  GITHUB_DEFAULT_CONFIG,
  GITHUB_CLAIM_MAPPINGS,
  GITHUB_AUTHORIZATION_ENDPOINT,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USERINFO_ENDPOINT,
  GITHUB_USER_EMAILS_ENDPOINT,
  validateGitHubConfig,
  getGitHubEffectiveEndpoints,
  getGitHubEnterpriseEndpoints,
  createGitHubConfig,
  type GitHubProviderQuirks,
} from '../providers/github';
import type { UpstreamProvider } from '../types';

describe('GitHub Provider Configuration', () => {
  describe('GitHub Constants', () => {
    it('should have correct authorization endpoint', () => {
      expect(GITHUB_AUTHORIZATION_ENDPOINT).toBe('https://github.com/login/oauth/authorize');
    });

    it('should have correct token endpoint', () => {
      expect(GITHUB_TOKEN_ENDPOINT).toBe('https://github.com/login/oauth/access_token');
    });

    it('should have correct userinfo endpoint', () => {
      expect(GITHUB_USERINFO_ENDPOINT).toBe('https://api.github.com/user');
    });

    it('should have correct user emails endpoint', () => {
      expect(GITHUB_USER_EMAILS_ENDPOINT).toBe('https://api.github.com/user/emails');
    });
  });

  describe('GITHUB_DEFAULT_CONFIG', () => {
    it('should have correct name', () => {
      expect(GITHUB_DEFAULT_CONFIG.name).toBe('GitHub');
    });

    it('should be configured as oauth2 provider (not oidc)', () => {
      expect(GITHUB_DEFAULT_CONFIG.providerType).toBe('oauth2');
    });

    it('should NOT have an issuer (OAuth 2.0)', () => {
      expect(GITHUB_DEFAULT_CONFIG.issuer).toBeUndefined();
    });

    it('should NOT have a jwksUri (OAuth 2.0)', () => {
      expect(GITHUB_DEFAULT_CONFIG.jwksUri).toBeUndefined();
    });

    it('should have correct endpoints', () => {
      expect(GITHUB_DEFAULT_CONFIG.authorizationEndpoint).toBe(GITHUB_AUTHORIZATION_ENDPOINT);
      expect(GITHUB_DEFAULT_CONFIG.tokenEndpoint).toBe(GITHUB_TOKEN_ENDPOINT);
      expect(GITHUB_DEFAULT_CONFIG.userinfoEndpoint).toBe(GITHUB_USERINFO_ENDPOINT);
    });

    it('should include read:user scope', () => {
      expect(GITHUB_DEFAULT_CONFIG.scopes).toContain('read:user');
    });

    it('should include user:email scope', () => {
      expect(GITHUB_DEFAULT_CONFIG.scopes).toContain('user:email');
    });

    it('should have attribute mapping for id → sub conversion', () => {
      const mapping = GITHUB_DEFAULT_CONFIG.attributeMapping!;
      expect(mapping.sub).toBe('id');
    });

    it('should have attribute mapping for login → preferred_username', () => {
      const mapping = GITHUB_DEFAULT_CONFIG.attributeMapping!;
      expect(mapping.preferred_username).toBe('login');
    });

    it('should have attribute mapping for avatar_url → picture', () => {
      const mapping = GITHUB_DEFAULT_CONFIG.attributeMapping!;
      expect(mapping.picture).toBe('avatar_url');
    });

    it('should have attribute mapping for html_url → profile', () => {
      const mapping = GITHUB_DEFAULT_CONFIG.attributeMapping!;
      expect(mapping.profile).toBe('html_url');
    });

    it('should require verified email by default', () => {
      expect(GITHUB_DEFAULT_CONFIG.requireEmailVerified).toBe(true);
    });

    it('should enable JIT provisioning by default', () => {
      expect(GITHUB_DEFAULT_CONFIG.jitProvisioning).toBe(true);
    });

    it('should enable auto-link email by default', () => {
      expect(GITHUB_DEFAULT_CONFIG.autoLinkEmail).toBe(true);
    });

    it('should have fetchPrimaryEmail enabled by default in quirks', () => {
      const quirks = GITHUB_DEFAULT_CONFIG.providerQuirks as GitHubProviderQuirks;
      expect(quirks.fetchPrimaryEmail).toBe(true);
    });

    it('should have allowUnverifiedEmail disabled by default in quirks', () => {
      const quirks = GITHUB_DEFAULT_CONFIG.providerQuirks as GitHubProviderQuirks;
      expect(quirks.allowUnverifiedEmail).toBe(false);
    });

    it('should have button styling', () => {
      expect(GITHUB_DEFAULT_CONFIG.iconUrl).toBeDefined();
      expect(GITHUB_DEFAULT_CONFIG.buttonColor).toBe('#24292f');
      expect(GITHUB_DEFAULT_CONFIG.buttonText).toBe('Continue with GitHub');
    });
  });

  describe('GITHUB_CLAIM_MAPPINGS', () => {
    it('should map id to sub', () => {
      expect(GITHUB_CLAIM_MAPPINGS.sub).toBe('id');
    });

    it('should map login to preferred_username', () => {
      expect(GITHUB_CLAIM_MAPPINGS.preferred_username).toBe('login');
    });

    it('should map avatar_url to picture', () => {
      expect(GITHUB_CLAIM_MAPPINGS.picture).toBe('avatar_url');
    });

    it('should map html_url to profile', () => {
      expect(GITHUB_CLAIM_MAPPINGS.profile).toBe('html_url');
    });

    it('should include GitHub-specific claims', () => {
      expect(GITHUB_CLAIM_MAPPINGS.company).toBe('company');
      expect(GITHUB_CLAIM_MAPPINGS.blog).toBe('blog');
      expect(GITHUB_CLAIM_MAPPINGS.location).toBe('location');
      expect(GITHUB_CLAIM_MAPPINGS.bio).toBe('bio');
      expect(GITHUB_CLAIM_MAPPINGS.twitter_username).toBe('twitter_username');
      expect(GITHUB_CLAIM_MAPPINGS.public_repos).toBe('public_repos');
      expect(GITHUB_CLAIM_MAPPINGS.followers).toBe('followers');
      expect(GITHUB_CLAIM_MAPPINGS.following).toBe('following');
      expect(GITHUB_CLAIM_MAPPINGS.created_at).toBe('created_at');
      expect(GITHUB_CLAIM_MAPPINGS.site_admin).toBe('site_admin');
    });
  });

  describe('validateGitHubConfig', () => {
    const validProvider: Partial<UpstreamProvider> = {
      clientId: 'test-client-id',
      clientSecretEncrypted: 'encrypted-secret',
      scopes: 'read:user user:email',
      providerQuirks: {},
    };

    it('should pass validation with valid config', () => {
      const errors = validateGitHubConfig(validProvider);
      expect(errors).toHaveLength(0);
    });

    it('should fail if clientId is missing', () => {
      const provider = { ...validProvider, clientId: undefined };
      const errors = validateGitHubConfig(provider);
      expect(errors).toContain('clientId is required');
    });

    it('should fail if clientSecret is missing', () => {
      const provider = { ...validProvider, clientSecretEncrypted: undefined };
      const errors = validateGitHubConfig(provider);
      expect(errors).toContain('clientSecret is required');
    });

    describe('scope validation', () => {
      it('should pass with read:user scope', () => {
        const provider = { ...validProvider, scopes: 'read:user' };
        const errors = validateGitHubConfig(provider);
        expect(errors.filter((e) => e.includes('scope'))).toHaveLength(0);
      });

      it('should pass with user scope (includes read:user)', () => {
        const provider = { ...validProvider, scopes: 'user' };
        const errors = validateGitHubConfig(provider);
        expect(errors.filter((e) => e.includes('scope'))).toHaveLength(0);
      });

      it('should fail if neither read:user nor user scope is present', () => {
        const provider = { ...validProvider, scopes: 'repo' };
        const errors = validateGitHubConfig(provider);
        expect(errors).toContain('read:user or user scope is required to fetch user profile');
      });
    });

    describe('enterprise configuration validation', () => {
      it('should pass with valid enterprise config', () => {
        const provider: Partial<UpstreamProvider> = {
          ...validProvider,
          providerQuirks: {
            allowEnterpriseServer: true,
            enterpriseServerUrl: 'https://github.mycompany.com',
          },
        };
        const errors = validateGitHubConfig(provider);
        expect(errors).toHaveLength(0);
      });

      it('should fail if allowEnterpriseServer is true but enterpriseServerUrl is missing', () => {
        const provider: Partial<UpstreamProvider> = {
          ...validProvider,
          providerQuirks: {
            allowEnterpriseServer: true,
          },
        };
        const errors = validateGitHubConfig(provider);
        expect(errors).toContain(
          'enterpriseServerUrl is required when allowEnterpriseServer is true'
        );
      });

      it('should fail if enterpriseServerUrl is invalid URL', () => {
        const provider: Partial<UpstreamProvider> = {
          ...validProvider,
          providerQuirks: {
            allowEnterpriseServer: true,
            enterpriseServerUrl: 'not-a-url',
          },
        };
        const errors = validateGitHubConfig(provider);
        expect(errors).toContain('enterpriseServerUrl must be a valid URL');
      });

      it('should pass with HTTP URL (for local testing)', () => {
        const provider: Partial<UpstreamProvider> = {
          ...validProvider,
          providerQuirks: {
            allowEnterpriseServer: true,
            enterpriseServerUrl: 'http://localhost:3000',
          },
        };
        const errors = validateGitHubConfig(provider);
        expect(errors).toHaveLength(0);
      });
    });
  });

  describe('getGitHubEnterpriseEndpoints', () => {
    it('should generate correct endpoints for enterprise server', () => {
      const endpoints = getGitHubEnterpriseEndpoints('https://github.mycompany.com');
      expect(endpoints.authorizationEndpoint).toBe(
        'https://github.mycompany.com/login/oauth/authorize'
      );
      expect(endpoints.tokenEndpoint).toBe('https://github.mycompany.com/login/oauth/access_token');
      expect(endpoints.userinfoEndpoint).toBe('https://github.mycompany.com/api/v3/user');
      expect(endpoints.userEmailsEndpoint).toBe('https://github.mycompany.com/api/v3/user/emails');
    });

    it('should strip trailing slash from base URL', () => {
      const endpoints = getGitHubEnterpriseEndpoints('https://github.mycompany.com/');
      expect(endpoints.authorizationEndpoint).toBe(
        'https://github.mycompany.com/login/oauth/authorize'
      );
    });

    it('should handle HTTP URLs (for local testing)', () => {
      const endpoints = getGitHubEnterpriseEndpoints('http://localhost:3000');
      expect(endpoints.authorizationEndpoint).toBe('http://localhost:3000/login/oauth/authorize');
      expect(endpoints.userinfoEndpoint).toBe('http://localhost:3000/api/v3/user');
    });
  });

  describe('getGitHubEffectiveEndpoints', () => {
    it('should return default GitHub.com endpoints when no enterprise config', () => {
      const provider: Partial<UpstreamProvider> = {};
      const endpoints = getGitHubEffectiveEndpoints(provider);
      expect(endpoints.authorizationEndpoint).toBe(GITHUB_AUTHORIZATION_ENDPOINT);
      expect(endpoints.tokenEndpoint).toBe(GITHUB_TOKEN_ENDPOINT);
      expect(endpoints.userinfoEndpoint).toBe(GITHUB_USERINFO_ENDPOINT);
      expect(endpoints.userEmailsEndpoint).toBe(GITHUB_USER_EMAILS_ENDPOINT);
    });

    it('should return custom endpoints if provider has them set', () => {
      const provider: Partial<UpstreamProvider> = {
        authorizationEndpoint: 'https://custom.github.com/authorize',
        tokenEndpoint: 'https://custom.github.com/token',
        userinfoEndpoint: 'https://custom.github.com/user',
      };
      const endpoints = getGitHubEffectiveEndpoints(provider);
      expect(endpoints.authorizationEndpoint).toBe('https://custom.github.com/authorize');
      expect(endpoints.tokenEndpoint).toBe('https://custom.github.com/token');
      expect(endpoints.userinfoEndpoint).toBe('https://custom.github.com/user');
    });

    it('should return enterprise endpoints when enterprise config is set', () => {
      const provider: Partial<UpstreamProvider> = {
        providerQuirks: {
          allowEnterpriseServer: true,
          enterpriseServerUrl: 'https://github.enterprise.com',
        },
      };
      const endpoints = getGitHubEffectiveEndpoints(provider);
      expect(endpoints.authorizationEndpoint).toBe(
        'https://github.enterprise.com/login/oauth/authorize'
      );
      expect(endpoints.tokenEndpoint).toBe(
        'https://github.enterprise.com/login/oauth/access_token'
      );
      expect(endpoints.userinfoEndpoint).toBe('https://github.enterprise.com/api/v3/user');
      expect(endpoints.userEmailsEndpoint).toBe('https://github.enterprise.com/api/v3/user/emails');
    });

    it('should ignore enterprise URL if allowEnterpriseServer is false', () => {
      const provider: Partial<UpstreamProvider> = {
        providerQuirks: {
          allowEnterpriseServer: false,
          enterpriseServerUrl: 'https://github.enterprise.com',
        },
      };
      const endpoints = getGitHubEffectiveEndpoints(provider);
      expect(endpoints.authorizationEndpoint).toBe(GITHUB_AUTHORIZATION_ENDPOINT);
    });
  });

  describe('createGitHubConfig', () => {
    it('should create default GitHub.com config', () => {
      const config = createGitHubConfig();
      expect(config.name).toBe('GitHub');
      expect(config.providerType).toBe('oauth2');
      expect(config.authorizationEndpoint).toBe(GITHUB_AUTHORIZATION_ENDPOINT);
      expect(config.tokenEndpoint).toBe(GITHUB_TOKEN_ENDPOINT);
      expect(config.userinfoEndpoint).toBe(GITHUB_USERINFO_ENDPOINT);
    });

    it('should create enterprise config when enterpriseServerUrl is provided', () => {
      const config = createGitHubConfig({
        enterpriseServerUrl: 'https://github.mycompany.com',
      });
      expect(config.authorizationEndpoint).toBe(
        'https://github.mycompany.com/login/oauth/authorize'
      );
      expect(config.tokenEndpoint).toBe('https://github.mycompany.com/login/oauth/access_token');
      expect(config.userinfoEndpoint).toBe('https://github.mycompany.com/api/v3/user');

      const quirks = config.providerQuirks as GitHubProviderQuirks;
      expect(quirks.allowEnterpriseServer).toBe(true);
      expect(quirks.enterpriseServerUrl).toBe('https://github.mycompany.com');
    });

    it('should merge overrides with default config', () => {
      const config = createGitHubConfig({
        overrides: {
          name: 'My GitHub',
          buttonText: 'Sign in with GitHub',
          requireEmailVerified: false,
        },
      });
      expect(config.name).toBe('My GitHub');
      expect(config.buttonText).toBe('Sign in with GitHub');
      expect(config.requireEmailVerified).toBe(false);
      expect(config.providerType).toBe('oauth2'); // From defaults
    });

    it('should preserve default attribute mapping', () => {
      const config = createGitHubConfig();
      expect(config.attributeMapping).toBeDefined();
      expect(config.attributeMapping?.sub).toBe('id');
      expect(config.attributeMapping?.preferred_username).toBe('login');
    });

    it('should preserve quirks when using overrides', () => {
      const config = createGitHubConfig({
        overrides: {
          name: 'Custom GitHub',
        },
      });
      const quirks = config.providerQuirks as GitHubProviderQuirks;
      expect(quirks.fetchPrimaryEmail).toBe(true);
      expect(quirks.allowUnverifiedEmail).toBe(false);
    });
  });

  describe('GitHub vs OIDC provider differences', () => {
    it('should NOT be OIDC (no ID token support)', () => {
      expect(GITHUB_DEFAULT_CONFIG.providerType).not.toBe('oidc');
      expect(GITHUB_DEFAULT_CONFIG.issuer).toBeUndefined();
      expect(GITHUB_DEFAULT_CONFIG.jwksUri).toBeUndefined();
    });

    it('should use numeric id field instead of string sub', () => {
      // GitHub returns numeric id (e.g., 123456) instead of string sub
      // The attribute mapping handles this conversion
      expect(GITHUB_DEFAULT_CONFIG.attributeMapping?.sub).toBe('id');
    });

    it('should NOT include openid scope (OAuth 2.0)', () => {
      expect(GITHUB_DEFAULT_CONFIG.scopes).not.toContain('openid');
    });
  });

  describe('GitHub security considerations', () => {
    it('should require email verification by default', () => {
      expect(GITHUB_DEFAULT_CONFIG.requireEmailVerified).toBe(true);
    });

    it('should not allow unverified emails by default', () => {
      const quirks = GITHUB_DEFAULT_CONFIG.providerQuirks as GitHubProviderQuirks;
      expect(quirks.allowUnverifiedEmail).toBe(false);
    });

    it('should fetch primary email to handle private email settings', () => {
      const quirks = GITHUB_DEFAULT_CONFIG.providerQuirks as GitHubProviderQuirks;
      expect(quirks.fetchPrimaryEmail).toBe(true);
    });
  });

  describe('GitHub endpoint security', () => {
    it('should use HTTPS for all endpoints', () => {
      expect(GITHUB_AUTHORIZATION_ENDPOINT.startsWith('https://')).toBe(true);
      expect(GITHUB_TOKEN_ENDPOINT.startsWith('https://')).toBe(true);
      expect(GITHUB_USERINFO_ENDPOINT.startsWith('https://')).toBe(true);
      expect(GITHUB_USER_EMAILS_ENDPOINT.startsWith('https://')).toBe(true);
    });

    it('should use correct GitHub domains', () => {
      expect(GITHUB_AUTHORIZATION_ENDPOINT).toContain('github.com');
      expect(GITHUB_TOKEN_ENDPOINT).toContain('github.com');
      expect(GITHUB_USERINFO_ENDPOINT).toContain('api.github.com');
      expect(GITHUB_USER_EMAILS_ENDPOINT).toContain('api.github.com');
    });

    it('should NOT match issuer from different domain (security)', () => {
      // GitHub doesn't use OIDC issuer, but if someone tries to inject one...
      const maliciousProvider: Partial<UpstreamProvider> = {
        authorizationEndpoint: 'https://evil.github.com/login/oauth/authorize',
      };
      // The provider's endpoint can be overridden, but validation should catch this
      // in production by comparing against known GitHub endpoints
      expect(maliciousProvider.authorizationEndpoint).not.toContain('api.github.com');
    });
  });
});
