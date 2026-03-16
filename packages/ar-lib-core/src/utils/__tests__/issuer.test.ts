/**
 * Issuer URL Builder Tests
 *
 * Tests for:
 * - buildIssuerUrl: single-tenant vs multi-tenant
 * - isMultiTenantEnabled: MT mode detection
 * - validateHostHeader: Host validation
 * - extractSubdomain: subdomain extraction
 */

import { describe, it, expect } from 'vitest';
import {
  buildIssuerUrl,
  isMultiTenantEnabled,
  validateHostHeader,
  extractSubdomain,
} from '../issuer';
import type { Env } from '../../types/env';

describe('Issuer URL Builder', () => {
  describe('buildIssuerUrl', () => {
    describe('single-tenant mode', () => {
      it('should return ISSUER_URL when BASE_DOMAIN not set', () => {
        const env = {
          ISSUER_URL: 'https://auth.example.com',
        } as Env;

        const issuer = buildIssuerUrl(env);
        expect(issuer).toBe('https://auth.example.com');
      });

      it('should ignore tenantSubdomain parameter in single-tenant mode', () => {
        const env = {
          ISSUER_URL: 'https://auth.example.com',
        } as Env;

        const issuer = buildIssuerUrl(env, 'acme');
        expect(issuer).toBe('https://auth.example.com');
      });
    });

    describe('multi-tenant mode', () => {
      const mtEnv = {
        ISSUER_URL: 'https://auth.example.com',
        BASE_DOMAIN: 'authrim.com',
      } as Env;

      it('should build issuer from subdomain + BASE_DOMAIN', () => {
        const issuer = buildIssuerUrl(mtEnv, 'acme');
        expect(issuer).toBe('https://acme.authrim.com');
      });

      it('should use default tenant ID when subdomain not provided', () => {
        const issuer = buildIssuerUrl(mtEnv);
        expect(issuer).toBe('https://default.authrim.com');
      });

      it('should use naked base domain for the primary/default tenant when enabled', () => {
        const issuer = buildIssuerUrl({
          ...mtEnv,
          DEFAULT_TENANT_ID: 'default',
          NAKED_DOMAIN_AS_ISSUER: 'true',
        } as Env);

        expect(issuer).toBe('https://authrim.com');
      });

      it('should keep subdomain URLs for non-primary tenants when naked domain is enabled', () => {
        const issuer = buildIssuerUrl({
          ...mtEnv,
          DEFAULT_TENANT_ID: 'default',
          PRIMARY_TENANT_ID: 'default',
          NAKED_DOMAIN_AS_ISSUER: 'true',
        } as Env, 'acme');

        expect(issuer).toBe('https://acme.authrim.com');
      });

      it('should use PRIMARY_TENANT_ID for naked-domain issuer selection', () => {
        expect(
          buildIssuerUrl(
            {
              ...mtEnv,
              DEFAULT_TENANT_ID: 'default',
              PRIMARY_TENANT_ID: 'main',
              NAKED_DOMAIN_AS_ISSUER: 'true',
            } as Env,
            'main'
          )
        ).toBe('https://authrim.com');
      });

      it('should handle different subdomains', () => {
        expect(buildIssuerUrl(mtEnv, 'tenant1')).toBe('https://tenant1.authrim.com');
        expect(buildIssuerUrl(mtEnv, 'company-a')).toBe('https://company-a.authrim.com');
        expect(buildIssuerUrl(mtEnv, 'dev')).toBe('https://dev.authrim.com');
      });

      it('should handle complex tenant subdomains', () => {
        // Tenant ID can include hyphens
        expect(buildIssuerUrl(mtEnv, 'acme-prod')).toBe('https://acme-prod.authrim.com');
        expect(buildIssuerUrl(mtEnv, 'acme-staging')).toBe('https://acme-staging.authrim.com');
      });
    });
  });

  describe('isMultiTenantEnabled', () => {
    it('should return true when BASE_DOMAIN is set', () => {
      const env = {
        BASE_DOMAIN: 'authrim.com',
      };

      expect(isMultiTenantEnabled(env)).toBe(true);
    });

    it('should return false when BASE_DOMAIN is not set', () => {
      const env = {};

      expect(isMultiTenantEnabled(env)).toBe(false);
    });

    it('should return false for empty env', () => {
      expect(isMultiTenantEnabled({})).toBe(false);
    });
  });

  describe('validateHostHeader', () => {
    describe('single-tenant mode', () => {
      it('should always return valid with default tenant', () => {
        const result = validateHostHeader('auth.example.com', {
          ISSUER_URL: 'https://auth.example.com',
        });

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('default');
        expect(result.error).toBeUndefined();
      });

      it('should use DEFAULT_TENANT_ID from env if provided', () => {
        const result = validateHostHeader('auth.example.com', {
          ISSUER_URL: 'https://auth.example.com',
          DEFAULT_TENANT_ID: 'main',
        });

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('main');
      });

      it('should ignore host value in single-tenant mode', () => {
        const result = validateHostHeader(undefined, {
          ISSUER_URL: 'https://auth.example.com',
        });

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('default');
      });
    });

    describe('multi-tenant mode', () => {
      const mtEnv = {
        BASE_DOMAIN: 'authrim.com',
      };

      it('should extract tenant from valid subdomain', () => {
        const result = validateHostHeader('acme.authrim.com', mtEnv);

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('acme');
        expect(result.error).toBeUndefined();
      });

      it('should handle host with port', () => {
        const result = validateHostHeader('acme.authrim.com:443', mtEnv);

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('acme');
      });

      it('should return error for missing Host header', () => {
        const result = validateHostHeader(undefined, mtEnv);

        expect(result.valid).toBe(false);
        expect(result.tenantId).toBeNull();
        expect(result.error).toBe('missing_host');
        expect(result.statusCode).toBe(400);
      });

      it('should return error for invalid Host format', () => {
        const result = validateHostHeader('!invalid!.authrim.com', mtEnv);

        expect(result.valid).toBe(false);
        expect(result.tenantId).toBeNull();
        expect(result.error).toBe('invalid_format');
        expect(result.statusCode).toBe(400);
      });

      it('should handle naked domain with DEFAULT_TENANT_ID', () => {
        const result = validateHostHeader('authrim.com', { ...mtEnv, DEFAULT_TENANT_ID: 'main' });

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('main');
      });

      it('should handle naked domain with PRIMARY_TENANT_ID', () => {
        const result = validateHostHeader('authrim.com', {
          ...mtEnv,
          PRIMARY_TENANT_ID: 'primary',
        });

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('primary');
      });

      it('should return error for different base domain', () => {
        const result = validateHostHeader('acme.other-domain.com', mtEnv);

        expect(result.valid).toBe(false);
        expect(result.tenantId).toBeNull();
        expect(result.error).toBe('tenant_not_found');
        expect(result.statusCode).toBe(404);
      });

      it('should handle complex tenant subdomain', () => {
        const result = validateHostHeader('acme-prod.authrim.com', mtEnv);

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('acme-prod');
      });

      it('should reject sub-subdomain (multi-level)', () => {
        const result = validateHostHeader('dev.acme.authrim.com', mtEnv);

        expect(result.valid).toBe(false);
        expect(result.error).toBe('invalid_format');
        expect(result.statusCode).toBe(400);
      });

      it('should reject sub-subdomain with port', () => {
        const result = validateHostHeader('api.tenant.authrim.com:8080', mtEnv);

        expect(result.valid).toBe(false);
        expect(result.error).toBe('invalid_format');
        expect(result.statusCode).toBe(400);
      });
    });

    describe('Host format validation', () => {
      const mtEnv = {
        BASE_DOMAIN: 'authrim.com',
      };

      it('should reject Host starting with hyphen', () => {
        const result = validateHostHeader('-invalid.authrim.com', mtEnv);

        expect(result.valid).toBe(false);
        expect(result.error).toBe('invalid_format');
      });

      it('should reject Host ending with hyphen', () => {
        const result = validateHostHeader('invalid-.authrim.com', mtEnv);

        expect(result.valid).toBe(false);
        expect(result.error).toBe('invalid_format');
      });

      it('should reject Host with special characters', () => {
        const result = validateHostHeader('inv@lid.authrim.com', mtEnv);

        expect(result.valid).toBe(false);
        expect(result.error).toBe('invalid_format');
      });

      it('should accept valid alphanumeric with hyphens', () => {
        const result = validateHostHeader('my-tenant-1.authrim.com', mtEnv);

        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe('my-tenant-1');
      });
    });
  });

  describe('extractSubdomain', () => {
    it('should extract simple subdomain', () => {
      const subdomain = extractSubdomain('acme.authrim.com', 'authrim.com');
      expect(subdomain).toBe('acme');
    });

    it('should extract subdomain with hyphen', () => {
      const subdomain = extractSubdomain('acme-prod.authrim.com', 'authrim.com');
      expect(subdomain).toBe('acme-prod');
    });

    it('should handle host with port', () => {
      const subdomain = extractSubdomain('acme.authrim.com:8080', 'authrim.com');
      expect(subdomain).toBe('acme');
    });

    it('should return null for apex domain', () => {
      const subdomain = extractSubdomain('authrim.com', 'authrim.com');
      expect(subdomain).toBeNull();
    });

    it('should return null for different base domain', () => {
      const subdomain = extractSubdomain('acme.other.com', 'authrim.com');
      expect(subdomain).toBeNull();
    });

    it('should return null for partial base domain match', () => {
      // notauthrim.com should not match authrim.com
      const subdomain = extractSubdomain('acme.notauthrim.com', 'authrim.com');
      expect(subdomain).toBeNull();
    });

    it('should reject multi-level subdomain (sub-subdomain)', () => {
      // dev.acme.authrim.com should be rejected (sub-subdomain not allowed)
      const subdomain = extractSubdomain('dev.acme.authrim.com', 'authrim.com');
      expect(subdomain).toBeNull();
    });

    it('should return null for empty hostname', () => {
      const subdomain = extractSubdomain('', 'authrim.com');
      expect(subdomain).toBeNull();
    });

    it('should handle base domain with subdomain itself', () => {
      // api.authrim.app as base domain
      const subdomain = extractSubdomain('acme.api.authrim.app', 'api.authrim.app');
      expect(subdomain).toBe('acme');
    });
  });
});
