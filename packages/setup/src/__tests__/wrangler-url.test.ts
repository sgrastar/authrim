/**
 * Wrangler URL / Env Vars Matrix Tests v2
 *
 * Tests generateEnvVars() and deriveAllowedOrigins() across 27 representative scenarios.
 * All expected values are hardcoded in deployment-matrix.ts — no calculation here.
 */

import { describe, it, expect } from 'vitest';
import { generateEnvVars, deriveAllowedOrigins } from '../core/wrangler.js';
import type { AuthrimConfig } from '../core/config.js';
import {
  SCENARIOS,
  buildAuthrimConfig,
  scenarioLabel,
  WORKERS_SUBDOMAIN,
  type Scenario,
} from '../../../../test/fixtures/deployment-matrix.js';

// =============================================================================
// deriveAllowedOrigins — 27 tests
// =============================================================================

describe('deriveAllowedOrigins', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const origins = deriveAllowedOrigins(config, WORKERS_SUBDOMAIN);

    expect(origins.sort()).toEqual(scenario.expected.allowedOrigins.sort());
  });
});

// =============================================================================
// generateEnvVars — ar-auth × 27 tests
// =============================================================================

describe('generateEnvVars - ar-auth', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);
    const expected = scenario.expected.arAuthEnvVars;

    expect(vars['ISSUER_URL']).toBe(expected.ISSUER_URL);
    expect(vars['UI_URL']).toBe(expected.UI_URL);
    expect(vars['ADMIN_UI_URL']).toBe(expected.ADMIN_UI_URL);
    expect(vars['COOKIE_SAME_SITE']).toBe(expected.COOKIE_SAME_SITE);
    expect(vars['ADMIN_COOKIE_SAME_SITE']).toBe(expected.ADMIN_COOKIE_SAME_SITE);
    expect(vars['DEFAULT_TENANT_ID']).toBe(expected.DEFAULT_TENANT_ID);

    // BASE_DOMAIN
    if (expected.BASE_DOMAIN) {
      expect(vars['BASE_DOMAIN']).toBe(expected.BASE_DOMAIN);
    } else {
      expect(vars['BASE_DOMAIN']).toBeUndefined();
    }

    // PRIMARY_TENANT_ID
    if (expected.PRIMARY_TENANT_ID) {
      expect(vars['PRIMARY_TENANT_ID']).toBe(expected.PRIMARY_TENANT_ID);
    } else {
      expect(vars['PRIMARY_TENANT_ID']).toBeUndefined();
    }

    // NAKED_DOMAIN_AS_ISSUER
    if (expected.NAKED_DOMAIN_AS_ISSUER) {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBe('true');
    } else {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBeUndefined();
    }

    // ALLOWED_ORIGINS (order-insensitive)
    expect(vars['ALLOWED_ORIGINS']).toBeDefined();
    expect(vars['ALLOWED_ORIGINS'].split(',').sort()).toEqual(
      expected.ALLOWED_ORIGINS.split(',').sort()
    );
  });
});

// =============================================================================
// generateEnvVars — ar-management × 27 tests
// =============================================================================

describe('generateEnvVars - ar-management', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-management', config, WORKERS_SUBDOMAIN);
    const expected = scenario.expected.arManagementEnvVars;

    expect(vars['ISSUER_URL']).toBe(expected.ISSUER_URL);
    expect(vars['DEFAULT_TENANT_ID']).toBe(expected.DEFAULT_TENANT_ID);
    expect(vars['ADMIN_UI_URL']).toBe(expected.ADMIN_UI_URL);
    expect(vars['ADMIN_COOKIE_SAME_SITE']).toBe(expected.ADMIN_COOKIE_SAME_SITE);

    expect(vars['ALLOWED_ORIGINS']).toBeDefined();
    expect(vars['ALLOWED_ORIGINS'].split(',').sort()).toEqual(
      expected.ALLOWED_ORIGINS.split(',').sort()
    );

    if (scenario.config.baseDomain) {
      expect(vars['BASE_DOMAIN']).toBe(scenario.config.baseDomain);
    } else {
      expect(vars['BASE_DOMAIN']).toBeUndefined();
    }

    if (scenario.config.primaryTenantId) {
      expect(vars['PRIMARY_TENANT_ID']).toBe(scenario.config.primaryTenantId);
    } else {
      expect(vars['PRIMARY_TENANT_ID']).toBeUndefined();
    }

    if (scenario.config.nakedDomain) {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBe('true');
    } else {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBeUndefined();
    }
  });
});

// =============================================================================
// generateEnvVars — ar-router × 27 tests
// =============================================================================

describe('generateEnvVars - ar-router', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-router', config, WORKERS_SUBDOMAIN);
    const expected = scenario.expected.arRouterEnvVars;

    expect(vars['DEFAULT_TENANT_ID']).toBe(expected.DEFAULT_TENANT_ID);

    // ar-router does NOT get ISSUER_URL
    expect(vars['ISSUER_URL']).toBeUndefined();

    expect(vars['ALLOWED_ORIGINS']).toBeDefined();
    expect(vars['ALLOWED_ORIGINS'].split(',').sort()).toEqual(
      expected.ALLOWED_ORIGINS.split(',').sort()
    );

    // UI proxy flags — always present on ar-router
    const adminSameAsApi = scenario.config.adminUiSameAsApi;
    const loginSameAsApi = scenario.config.loginUiSameAsApi;

    expect(vars['ENABLE_ADMIN_UI_PROXY']).toBe(adminSameAsApi ? 'true' : 'false');
    expect(vars['ENABLE_LOGIN_UI_PROXY']).toBe(loginSameAsApi ? 'true' : 'false');

    // AR_ADMIN_UI_URL is set only when adminSameAsApi=true
    if (adminSameAsApi) {
      const adminPagesUrl = scenario.config.adminUiAuto ?? scenario.config.adminUiCustom;
      expect(vars['AR_ADMIN_UI_URL']).toBe(adminPagesUrl ?? undefined);
    } else {
      expect(vars['AR_ADMIN_UI_URL']).toBeUndefined();
    }

    // AR_LOGIN_UI_URL is set only when loginSameAsApi=true
    if (loginSameAsApi) {
      const loginPagesUrl = scenario.config.loginUiAuto ?? scenario.config.loginUiCustom;
      expect(vars['AR_LOGIN_UI_URL']).toBe(loginPagesUrl ?? undefined);
    } else {
      expect(vars['AR_LOGIN_UI_URL']).toBeUndefined();
    }
  });
});

// =============================================================================
// Setup URL base — 27 tests
// =============================================================================

describe('Setup URL base', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario);
    const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
    expect(apiUrl).toBe(scenario.expected.setupUrlBase);
  });
});

// =============================================================================
// sameAsApi UI_URL uses API domain (previously a spec gap, now fixed)
// =============================================================================

describe('sameAsApi produces UI_URL = API domain', () => {
  const sameAsApiScenarios = SCENARIOS.filter((s) => s.config.loginUiSameAsApi);

  it.each(sameAsApiScenarios.map((s) => [scenarioLabel(s), s] as const))(
    '%s - UI_URL should be API domain',
    (_label, scenario) => {
      const config = buildAuthrimConfig(scenario) as AuthrimConfig;
      const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);
      const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
      expect(vars['UI_URL']).toBe(apiUrl);
    }
  );
});

// =============================================================================
// ISSUER_URL consistency — verify wrangler ISSUER_URL aligns with issuer logic
// =============================================================================

describe('ISSUER_URL consistency with runtime issuer', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);

    if (scenario.config.baseDomain) {
      // Multi-tenant mode: buildIssuerUrl() ignores ISSUER_URL and dynamically
      // builds from {tenant}.{baseDomain}. The ISSUER_URL env var is set to the
      // auto (workers.dev) URL as a fallback for internal routing.
      expect(vars['ISSUER_URL']).toBe(scenario.config.apiAuto);
    } else {
      // Single-tenant mode: buildIssuerUrl() uses env.ISSUER_URL directly.
      // The ISSUER_URL env var must equal the expected runtime issuer URL.
      expect(vars['ISSUER_URL']).toBe(scenario.expected.issuerUrl);
    }
  });
});
