/**
 * Issuer URL & Host Validation Matrix Tests v2
 *
 * Tests buildIssuerUrl() and validateHostHeader() across 27 representative scenarios.
 * All expected values are hardcoded in deployment-topology-matrix.ts — no calculation here.
 */

import { describe, it, expect } from 'vitest';
import { buildIssuerUrl, getDefaultTenantId, validateHostHeader } from '../issuer';
import type { Env } from '../../types/env';
import {
  SCENARIOS,
  buildEnvFromScenario,
  scenarioLabel,
  getScenariosWithBaseDomain,
  getScenariosWithoutBaseDomain,
  BASE_DOMAIN,
  DEFAULT_TENANT,
  PRIMARY_TENANT,
} from '../../../../../test/shared-fixtures/deployment-topology-matrix';

// =============================================================================
// buildIssuerUrl tests — 27 default + 27 with tenant = 54 tests
// =============================================================================

describe('buildIssuerUrl - default tenant', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const env = buildEnvFromScenario(scenario) as Partial<Env>;
    const result = buildIssuerUrl(env as Env, getDefaultTenantId(env));
    expect(result).toBe(scenario.expected.issuerUrl);
  });
});

describe('buildIssuerUrl - with tenant "acme"', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const env = buildEnvFromScenario(scenario) as Partial<Env>;
    const result = buildIssuerUrl(env as Env, 'acme');
    expect(result).toBe(scenario.expected.issuerUrlWithTenant);
  });
});

// =============================================================================
// validateHostHeader tests — ~30 tests
// =============================================================================

describe('validateHostHeader', () => {
  describe('single-tenant mode (no BASE_DOMAIN)', () => {
    const singleTenantScenarios = getScenariosWithoutBaseDomain();

    it.each(singleTenantScenarios.map((s) => [scenarioLabel(s), s] as const))(
      '%s - returns default tenant regardless of host',
      (_label, scenario) => {
        const env = buildEnvFromScenario(scenario) as Partial<Env>;
        const result = validateHostHeader('anything.example.com', env);
        expect(result.valid).toBe(true);
        expect(result.tenantId).toBe(DEFAULT_TENANT);
      }
    );
  });

  describe('multi-tenant mode (with BASE_DOMAIN)', () => {
    const multiTenantScenarios = getScenariosWithBaseDomain();

    describe('tenant subdomain access', () => {
      it.each(multiTenantScenarios.map((s) => [scenarioLabel(s), s] as const))(
        '%s - extracts tenant from subdomain',
        (_label, scenario) => {
          const env = buildEnvFromScenario(scenario) as Partial<Env>;
          const host = `acme.${BASE_DOMAIN}`;
          const result = validateHostHeader(host, env);
          expect(result.valid).toBe(true);
          expect(result.tenantId).toBe('acme');
        }
      );
    });

    describe('naked domain access', () => {
      it.each(multiTenantScenarios.map((s) => [scenarioLabel(s), s] as const))(
        '%s - resolves correct tenant for naked domain',
        (_label, scenario) => {
          const env = buildEnvFromScenario(scenario) as Partial<Env>;
          const result = validateHostHeader(BASE_DOMAIN, env);
          if (scenario.config.nakedDomain) {
            expect(result.valid).toBe(true);

            if (scenario.config.primaryTenantId) {
              expect(result.tenantId).toBe(PRIMARY_TENANT);
            } else {
              expect(result.tenantId).toBe(DEFAULT_TENANT);
            }
          } else {
            expect(result.valid).toBe(false);
            expect(result.tenantId).toBeNull();
            expect(result.error).toBe('tenant_not_found');
          }
        }
      );
    });

    describe('invalid host rejection', () => {
      it.each(multiTenantScenarios.map((s) => [scenarioLabel(s), s] as const))(
        '%s - rejects unrelated domain',
        (_label, scenario) => {
          const env = buildEnvFromScenario(scenario) as Partial<Env>;
          const result = validateHostHeader('evil.attacker.com', env);
          expect(result.valid).toBe(false);
          expect(result.error).toBe('tenant_not_found');
        }
      );
    });

    describe('missing host header', () => {
      it.each(multiTenantScenarios.map((s) => [scenarioLabel(s), s] as const))(
        '%s - rejects missing host',
        (_label, scenario) => {
          const env = buildEnvFromScenario(scenario) as Partial<Env>;
          const result = validateHostHeader(undefined, env);
          expect(result.valid).toBe(false);
          expect(result.error).toBe('missing_host');
        }
      );
    });
  });
});

// =============================================================================
// Special domain edge cases (ccTLD, geographic domains, IDN, Punycode)
// =============================================================================

describe('Special domain formats', () => {
  // -------------------------------------------------------------------------
  // buildIssuerUrl with special BASE_DOMAINs
  // -------------------------------------------------------------------------

  describe('buildIssuerUrl - ccTLD with multiple dots (example.co.jp)', () => {
    const env = {
      ISSUER_URL: 'https://api.example.co.jp',
      BASE_DOMAIN: 'example.co.jp',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('default tenant → https://default.example.co.jp', () => {
      expect(buildIssuerUrl(env as Env, getDefaultTenantId(env))).toBe(
        'https://default.example.co.jp'
      );
    });

    it('acme tenant → https://acme.example.co.jp', () => {
      expect(buildIssuerUrl(env as Env, 'acme')).toBe('https://acme.example.co.jp');
    });
  });

  describe('buildIssuerUrl - geographic domain (example.chiyoda.tokyo.jp)', () => {
    const env = {
      ISSUER_URL: 'https://api.example.chiyoda.tokyo.jp',
      BASE_DOMAIN: 'example.chiyoda.tokyo.jp',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('default tenant → https://default.example.chiyoda.tokyo.jp', () => {
      expect(buildIssuerUrl(env as Env, getDefaultTenantId(env))).toBe(
        'https://default.example.chiyoda.tokyo.jp'
      );
    });

    it('acme tenant → https://acme.example.chiyoda.tokyo.jp', () => {
      expect(buildIssuerUrl(env as Env, 'acme')).toBe('https://acme.example.chiyoda.tokyo.jp');
    });
  });

  describe('buildIssuerUrl - Punycode IDN (xn--wgv71a119e.jp)', () => {
    const env = {
      ISSUER_URL: 'https://api.xn--wgv71a119e.jp',
      BASE_DOMAIN: 'xn--wgv71a119e.jp',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('default tenant → https://default.xn--wgv71a119e.jp', () => {
      expect(buildIssuerUrl(env as Env, getDefaultTenantId(env))).toBe(
        'https://default.xn--wgv71a119e.jp'
      );
    });

    it('acme tenant → https://acme.xn--wgv71a119e.jp', () => {
      expect(buildIssuerUrl(env as Env, 'acme')).toBe('https://acme.xn--wgv71a119e.jp');
    });
  });

  // -------------------------------------------------------------------------
  // validateHostHeader with special BASE_DOMAINs
  // -------------------------------------------------------------------------

  describe('validateHostHeader - ccTLD (example.co.jp)', () => {
    const env = {
      BASE_DOMAIN: 'example.co.jp',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('extracts tenant from acme.example.co.jp', () => {
      const result = validateHostHeader('acme.example.co.jp', env);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('naked domain example.co.jp is rejected when omission is disabled', () => {
      const result = validateHostHeader('example.co.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('rejects partial match (evil.co.jp)', () => {
      const result = validateHostHeader('evil.co.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('rejects sub-subdomain (sub.acme.example.co.jp)', () => {
      const result = validateHostHeader('sub.acme.example.co.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });
  });

  describe('validateHostHeader - geographic domain (example.chiyoda.tokyo.jp)', () => {
    const env = {
      BASE_DOMAIN: 'example.chiyoda.tokyo.jp',
      DEFAULT_TENANT_ID: 'default',
      PRIMARY_TENANT_ID: 'primary',
      NAKED_DOMAIN_AS_ISSUER: 'true',
    } as Partial<Env>;

    it('extracts tenant from acme.example.chiyoda.tokyo.jp', () => {
      const result = validateHostHeader('acme.example.chiyoda.tokyo.jp', env);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('naked domain → primary tenant', () => {
      const result = validateHostHeader('example.chiyoda.tokyo.jp', env);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('primary');
    });

    it('rejects unrelated geographic domain (evil.chiyoda.tokyo.jp)', () => {
      const result = validateHostHeader('evil.chiyoda.tokyo.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });
  });

  describe('validateHostHeader - uppercase host (EXAMPLE.CHIYODA.TOKYO.JP)', () => {
    // HTTP Host header is case-insensitive per RFC 7230.
    // validateHostHeader normalizes hostname to lowercase before comparison.
    const env = {
      BASE_DOMAIN: 'example.chiyoda.tokyo.jp',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('uppercase naked domain is rejected when omission is disabled', () => {
      const result = validateHostHeader('EXAMPLE.CHIYODA.TOKYO.JP', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('mixed case subdomain is normalized', () => {
      const result = validateHostHeader('ACME.EXAMPLE.CHIYODA.TOKYO.JP', env);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('lowercase naked host is also rejected when omission is disabled', () => {
      const result = validateHostHeader('example.chiyoda.tokyo.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('uppercase naked domain resolves when omission is enabled', () => {
      const result = validateHostHeader('EXAMPLE.CHIYODA.TOKYO.JP', {
        ...env,
        NAKED_DOMAIN_AS_ISSUER: 'true',
      });
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('default');
    });
  });

  describe('validateHostHeader - Punycode IDN (xn--wgv71a119e.jp)', () => {
    const env = {
      BASE_DOMAIN: 'xn--wgv71a119e.jp',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('extracts tenant from acme.xn--wgv71a119e.jp', () => {
      const result = validateHostHeader('acme.xn--wgv71a119e.jp', env);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('naked domain xn--wgv71a119e.jp is rejected when omission is disabled', () => {
      const result = validateHostHeader('xn--wgv71a119e.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });
  });

  describe('validateHostHeader - Unicode IDN (日本語.jp)', () => {
    // Browsers send Host header as Punycode (A-label), not Unicode (U-label).
    // isValidHostFormat rejects non-ASCII characters, so direct Unicode fails.
    const env = {
      BASE_DOMAIN: '日本語.jp',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('rejects Unicode host as invalid_format', () => {
      const result = validateHostHeader('日本語.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('rejects Unicode subdomain host as invalid_format', () => {
      const result = validateHostHeader('acme.日本語.jp', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });
  });

  describe('validateHostHeader - IDN TLD (.テスト)', () => {
    // Japanese IDN TLD (xn--zckzah in Punycode).
    // Direct Unicode is rejected by isValidHostFormat.
    const env = {
      BASE_DOMAIN: 'example.テスト',
      DEFAULT_TENANT_ID: 'default',
    } as Partial<Env>;

    it('rejects Unicode TLD host as invalid_format', () => {
      const result = validateHostHeader('example.テスト', env);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('Punycode equivalent (example.xn--zckzah) works with Punycode BASE_DOMAIN', () => {
      const punycodeEnv = {
        BASE_DOMAIN: 'example.xn--zckzah',
        DEFAULT_TENANT_ID: 'default',
      } as Partial<Env>;

      const result = validateHostHeader('acme.example.xn--zckzah', punycodeEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });
  });
});
