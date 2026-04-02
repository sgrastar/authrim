import { describe, expect, it } from 'vitest';
import { computeApiDomainUiState, isValidCustomDomain } from '../web/domain-form-state.js';

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

  it('shows naked-domain examples with a distinct primary tenant when configured', () => {
    const state = computeApiDomainUiState({
      baseDomain: 'test.authrim.com',
      multiTenantChecked: true,
      nakedDomainChecked: true,
      tenantName: 'default',
      primaryTenant: 'acme',
    });

    expect(state.showTenantFields).toBe(false);
    expect(state.showPrimaryTenantRow).toBe(true);
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
    expect(state.showPrimaryTenantRow).toBe(true);
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
    expect(isValidCustomDomain('localhost')).toBe(false);
    expect(isValidCustomDomain('')).toBe(false);
  });
});
