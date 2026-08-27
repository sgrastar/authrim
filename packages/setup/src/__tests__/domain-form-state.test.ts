import { describe, expect, it } from 'vitest';
import {
  computeApiDomainUiState,
  isValidCustomDomain,
  validateSetupDomainInputs,
} from '../web/domain-form-state.js';

describe('computeApiDomainUiState', () => {
  it('treats workers.dev mode as single-tenant with no custom-domain-only controls', () => {
    const state = computeApiDomainUiState({
      baseDomain: '',
      multiTenantChecked: false,
      nakedDomainChecked: false,
      tenantName: 'default',
    });

    expect(state.hasBaseDomain).toBe(false);
    expect(state.multiTenantEnabled).toBe(false);
    expect(state.showWorkersDevNote).toBe(true);
    expect(state.showNakedDomainControls).toBe(false);
    expect(state.showTenantFields).toBe(true);
    expect(state.showPrimaryTenantRow).toBe(false);
    expect(state.showExamples).toBe(false);
    expect(state.multiTenantHintMode).toBe('needs-custom-domain');
  });

  it('keeps custom-domain single-tenant mode free of tenant URL examples', () => {
    const state = computeApiDomainUiState({
      baseDomain: 'test.authrim.com',
      multiTenantChecked: false,
      nakedDomainChecked: false,
      tenantName: 'default',
    });

    expect(state.hasBaseDomain).toBe(true);
    expect(state.multiTenantEnabled).toBe(false);
    expect(state.showNakedDomainControls).toBe(false);
    expect(state.showExamples).toBe(false);
    expect(state.multiTenantHintMode).toBe('single-tenant');
  });

  it('builds first-tenant and other-tenant rows for subdomain multi-tenant mode', () => {
    const state = computeApiDomainUiState({
      baseDomain: 'test.authrim.com',
      multiTenantChecked: true,
      nakedDomainChecked: false,
      tenantName: 'default',
    });

    expect(state.multiTenantEnabled).toBe(true);
    expect(state.showNakedDomainControls).toBe(true);
    expect(state.showTenantFields).toBe(true);
    expect(state.showPrimaryTenantRow).toBe(false);
    expect(state.showExamples).toBe(true);
    expect(state.exampleRows).toEqual([
      {
        kind: 'initial-tenant',
        tenantName: 'default',
        url: 'https://default.test.authrim.com',
      },
      {
        kind: 'other-tenant',
        url: 'https://{tenantName}.test.authrim.com',
      },
    ]);
  });

  it('keeps the primary tenant field hidden in naked-domain mode', () => {
    const state = computeApiDomainUiState({
      baseDomain: 'test.authrim.com',
      multiTenantChecked: true,
      nakedDomainChecked: true,
      tenantName: 'default',
      primaryTenant: 'acme',
    });

    expect(state.showTenantFields).toBe(false);
    expect(state.showPrimaryTenantRow).toBe(false);
    expect(state.nakedDomainHintMode).toBe('omit-tenant');
    expect(state.exampleRows).toEqual([
      {
        kind: 'initial-tenant',
        tenantName: 'acme',
        url: 'https://test.authrim.com',
      },
      {
        kind: 'initial-tenant-explicit',
        tenantName: 'default',
        url: 'https://default.test.authrim.com',
      },
      {
        kind: 'other-tenant',
        url: 'https://{tenantName}.test.authrim.com',
      },
    ]);
  });

  it('uses the initial tenant as the omitted-domain tenant when primaryTenant is not provided', () => {
    const state = computeApiDomainUiState({
      baseDomain: 'test.authrim.com',
      multiTenantChecked: true,
      nakedDomainChecked: true,
      tenantName: 'acme',
    });

    expect(state.showTenantFields).toBe(false);
    expect(state.showPrimaryTenantRow).toBe(false);
    expect(state.exampleRows).toEqual([
      {
        kind: 'initial-tenant',
        tenantName: 'acme',
        url: 'https://test.authrim.com',
      },
      {
        kind: 'other-tenant',
        url: 'https://{tenantName}.test.authrim.com',
      },
    ]);
  });
});

describe('isValidCustomDomain', () => {
  it('accepts ordinary hostnames and rejects incomplete values', () => {
    expect(isValidCustomDomain('test.authrim.com')).toBe(true);
    expect(isValidCustomDomain('TEST.authrim.com')).toBe(true);
    expect(isValidCustomDomain('localhost')).toBe(false);
    expect(isValidCustomDomain('')).toBe(false);
    expect(isValidCustomDomain('foo..example.com')).toBe(false);
    expect(isValidCustomDomain('foo-.example.com')).toBe(false);
    expect(isValidCustomDomain('-foo.example.com')).toBe(false);
    expect(isValidCustomDomain('foo.example.c')).toBe(false);
    expect(isValidCustomDomain('xn--bcher-kva.example.com')).toBe(false);
    expect(isValidCustomDomain('authrim.xn--p1ai')).toBe(false);
  });
});

describe('validateSetupDomainInputs', () => {
  it('allows a one-label deployment base domain such as multi-tenant.authrim.com', () => {
    expect(
      validateSetupDomainInputs({
        apiDomain: 'multi-tenant.authrim.com',
        loginUiDomain: 'login.multi-tenant.authrim.com',
        adminUiDomain: 'admin.multi-tenant.authrim.com',
      })
    ).toEqual([]);
  });

  it('allows UI domains outside the API base domain when they are one-label hosts', () => {
    expect(
      validateSetupDomainInputs({
        apiDomain: 'multi-tenant.authrim.com',
        loginUiDomain: 'login.authrim.com',
        adminUiDomain: 'admin.authrim.com',
      })
    ).toEqual([]);
  });

  it('rejects a base domain that already includes a tenant label', () => {
    const issues = validateSetupDomainInputs({
      apiDomain: 'first.multi-tenant.authrim.com',
      tenantName: 'first',
    });

    expect(issues).toEqual([
      expect.objectContaining({
        field: 'apiDomain',
        kind: 'baseDomainDepth',
        hostname: 'first.multi-tenant.authrim.com',
        suggestion: 'multi-tenant.authrim.com',
      }),
    ]);
  });

  it('rejects two-label UI hosts under the base domain and suggests a hyphenated host', () => {
    const issues = validateSetupDomainInputs({
      apiDomain: 'subdomain.example.com',
      loginUiDomain: 'login.tenantName.subdomain.example.com',
      adminUiDomain: 'admin.tenantName.subdomain.example.com',
    });

    expect(issues).toEqual([
      expect.objectContaining({
        field: 'loginUiDomain',
        kind: 'uiDomainDepth',
        hostname: 'login.tenantname.subdomain.example.com',
        suggestion: 'login-tenantname.subdomain.example.com',
      }),
      expect.objectContaining({
        field: 'adminUiDomain',
        suggestion: 'admin-tenantname.subdomain.example.com',
      }),
    ]);
  });

  it('rejects two-label UI hosts under a multi-label base domain', () => {
    const issues = validateSetupDomainInputs({
      apiDomain: 'multi-tenant.authrim.com',
      loginUiDomain: 'login.first.multi-tenant.authrim.com',
      adminUiDomain: 'admin.first.multi-tenant.authrim.com',
    });

    expect(issues).toEqual([
      expect.objectContaining({
        field: 'loginUiDomain',
        suggestion: 'login-first.multi-tenant.authrim.com',
      }),
      expect.objectContaining({
        field: 'adminUiDomain',
        suggestion: 'admin-first.multi-tenant.authrim.com',
      }),
    ]);
  });

  it('allows hyphenated one-label tenant UI hosts', () => {
    expect(
      validateSetupDomainInputs({
        apiDomain: 'subdomain.example.com',
        loginUiDomain: 'login-tenantName.subdomain.example.com',
        adminUiDomain: 'admin-tenantName.subdomain.example.com',
      })
    ).toEqual([]);
  });
});
