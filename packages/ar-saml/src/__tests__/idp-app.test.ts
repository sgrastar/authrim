import { describe, expect, it } from 'vitest';
import { createSAMLIdPApp } from '../idp-app';

describe('SAML IdP-only app', () => {
  it('exposes only the supported IdP and health routes', () => {
    const app = createSAMLIdPApp({
      tenantMiddleware: async (_c, next) => next(),
    });
    const routes = app.routes
      .filter((route) => route.method !== 'ALL')
      .map((route) => `${route.method} ${route.path}`);

    expect(routes).toContain('GET /saml/idp/metadata');
    expect(routes).toContain('GET /saml/idp/sso');
    expect(routes).toContain('POST /saml/idp/sso');
    expect(routes).toContain('POST /saml/idp/attribute-release-consent');
    expect(routes).not.toContain('GET /saml/idp/slo');
    expect(routes).not.toContain('POST /saml/idp/slo');
    expect(routes).toContain('GET /saml/health');
    expect(routes.some((route) => route.includes('/saml/sp/'))).toBe(false);
    expect(routes.some((route) => route.includes('/api/admin/'))).toBe(false);
  });

  it('exposes logout only when enabled', () => {
    const app = createSAMLIdPApp({
      tenantMiddleware: async (_c, next) => next(),
      sloEnabled: true,
    });
    const routes = app.routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toContain('GET /saml/idp/slo');
    expect(routes).toContain('POST /saml/idp/slo');
  });
});
