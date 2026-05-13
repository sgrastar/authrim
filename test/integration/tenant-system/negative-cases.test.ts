import { describe, expect, it } from 'vitest';
import type { LoginEntrySettings } from '@authrim/ar-lib-core';
import {
  applyLoginEntryProfile,
  buildEnvForTopology,
  createTenantSystemDiscoveryApp,
  expectDiscoveryConfig,
  loadMatrixCsv,
  makeCommonHost,
  makeTenantRequest,
} from './helpers';

interface NegativeMatrixRow {
  case_id: string;
  category: string;
  invalid_or_hostile_condition: string;
  expect: string;
}

describe('tenant-system negative case matrix', () => {
  const rows = loadMatrixCsv<NegativeMatrixRow>('tenant-system-negative-matrix.csv');

  it.each(rows)('$case_id has negative coverage metadata', (row) => {
    expect(row.category).toBeTruthy();
    expect(row.invalid_or_hostile_condition).toBeTruthy();
    expect(row.expect).toBeTruthy();
  });

  it('NEG-001 normalizes disabled email resolution by excluding email discovery at runtime', async () => {
    const env = await buildEnvForTopology('D3_custom_subdomain');
    const settings: LoginEntrySettings = {
      'login-entry.mode': 'discovery_optional',
      'login-entry.email_resolution_policy': 'disabled',
      'login-entry.selection_policy': 'select_if_multiple',
      'login-entry.discovery_methods': '["email_domain","tenant_code"]',
      'login-entry.allow_manual_tenant_entry': true,
      'login-entry.remember_last_tenant': true,
      'login-entry.redirect_default_login_to_discovery': true,
      'login-entry.require_common_discovery_before_login': true,
      'login-entry.skip_discovery_if_only_one_tenant': false,
      'login-entry.redirect_tenant_discover_to_common_entry': true,
    };
    await applyLoginEntryProfile(env, 'first', settings);

    const response = await createTenantSystemDiscoveryApp('first').request(
      makeTenantRequest(makeCommonHost('D3_custom_subdomain'), '/api/auth/discovery'),
      {},
      env
    );

    const body = await expectDiscoveryConfig(response, {
      email_resolution_policy: 'disabled',
      discovery_methods: ['tenant_code'],
    });
    expect(body.config.discovery_methods).not.toContain('email_domain');
  });

  it('NEG-004 keeps empty discovery methods fail-closed at runtime', async () => {
    const env = await buildEnvForTopology('D3_custom_subdomain');
    const settings: LoginEntrySettings = {
      'login-entry.mode': 'discovery_optional',
      'login-entry.email_resolution_policy': 'disabled',
      'login-entry.selection_policy': 'manual_only',
      'login-entry.discovery_methods': '[]',
      'login-entry.allow_manual_tenant_entry': false,
      'login-entry.remember_last_tenant': false,
      'login-entry.redirect_default_login_to_discovery': true,
      'login-entry.require_common_discovery_before_login': true,
      'login-entry.skip_discovery_if_only_one_tenant': false,
      'login-entry.redirect_tenant_discover_to_common_entry': true,
    };
    await applyLoginEntryProfile(env, 'first', settings);

    const response = await createTenantSystemDiscoveryApp('first').request(
      makeTenantRequest(makeCommonHost('D3_custom_subdomain'), '/api/auth/discovery'),
      {},
      env
    );

    await expectDiscoveryConfig(response, {
      email_resolution_policy: 'disabled',
      discovery_methods: [],
      allow_manual_tenant_entry: false,
    });
  });

  it.todo('NEG-002 should reject or normalize non-disabled email policy without email_domain');
  it.todo('NEG-003 should reject manual_only with email_domain or exclude email discovery');
});
