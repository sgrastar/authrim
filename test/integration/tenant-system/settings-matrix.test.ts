import { describe, expect, it } from 'vitest';
import {
  applyLoginEntryRow,
  buildEnvForTopology,
  createTenantSystemDiscoveryApp,
  expectDiscoveryConfig,
  loginEntrySettingsFromRow,
  makeCommonHost,
  makeTenantHost,
  makeTenantRequest,
  type SettingsMatrixRow,
} from './helpers';
import { loadMatrixCsv } from './fixtures/matrix-loader';

const MATRIX_FILES = [
  'tenant-system-3wise-constrained-valid-matrix.csv',
  'tenant-system-entry-route-matrix.csv',
  'tenant-system-discovery-input-data-matrix.csv',
  'tenant-system-oidc-tenant-matrix.csv',
  'tenant-system-cookie-session-matrix.csv',
  'tenant-system-negative-matrix.csv',
] as const;

const BOOLEAN_FIELDS = [
  'allow_manual',
  'remember_last',
  'redirect_common_login',
  'require_common_before_tenant_login',
  'skip_if_one_tenant',
] as const;

const KNOWN_DISCOVERY_METHODS = new Set(['email_exact', 'tenant_code', 'tenant_slug', 'app_hint']);

describe('tenant-system matrix fixtures', () => {
  it.each(MATRIX_FILES)('loads %s with required columns and unique case IDs', (filename) => {
    const rows = loadMatrixCsv(filename);
    expect(rows.length).toBeGreaterThan(0);

    const caseIds = new Set<string>();
    for (const row of rows) {
      expect(row.case_id).toBeTruthy();
      expect(row.expect).toBeTruthy();
      expect(caseIds.has(row.case_id)).toBe(false);
      caseIds.add(row.case_id);
    }
  });

  it('keeps the constrained settings matrix at the planned size', () => {
    const rows = loadMatrixCsv('tenant-system-3wise-constrained-valid-matrix.csv');
    expect(rows).toHaveLength(308);
  });

  it('uses valid boolean and discovery method values in the constrained settings matrix', () => {
    const rows = loadMatrixCsv<SettingsMatrixRow>(
      'tenant-system-3wise-constrained-valid-matrix.csv'
    );

    for (const row of rows) {
      for (const field of BOOLEAN_FIELDS) {
        expect(['true', 'false'], `${row.case_id} ${field}`).toContain(row[field]);
      }

      for (const method of row.discovery_methods.split('+')) {
        expect(KNOWN_DISCOVERY_METHODS.has(method), `${row.case_id} ${method}`).toBe(true);
      }
    }
  });
});

describe('tenant-system constrained settings matrix', () => {
  const rows = loadMatrixCsv<SettingsMatrixRow>('tenant-system-3wise-constrained-valid-matrix.csv');

  it.each(rows)('$case_id applies and loads discovery config without server error', async (row) => {
    const env = await buildEnvForTopology(row.topology);
    await applyLoginEntryRow(env, row);

    const settings = loginEntrySettingsFromRow(row);
    const expectedMethods = JSON.parse(settings['login-entry.discovery_methods']).filter(
      (method: string) =>
        settings['login-entry.email_resolution_policy'] !== 'disabled' || method !== 'email_exact'
    );

    const commonApp = createTenantSystemDiscoveryApp('first');
    const commonResponse = await commonApp.request(
      makeTenantRequest(makeCommonHost(row.topology), '/api/auth/discovery'),
      {},
      env
    );
    await expectDiscoveryConfig(commonResponse, {
      mode: settings['login-entry.mode'],
      discovery_methods: expectedMethods,
      email_resolution_policy: settings['login-entry.email_resolution_policy'],
      selection_policy: settings['login-entry.selection_policy'],
      allow_manual_tenant_entry: settings['login-entry.allow_manual_tenant_entry'],
      remember_last_tenant: settings['login-entry.remember_last_tenant'],
      redirect_default_login_to_discovery:
        settings['login-entry.redirect_default_login_to_discovery'],
      require_common_discovery_before_login:
        settings['login-entry.require_common_discovery_before_login'],
      skip_discovery_if_only_one_tenant: settings['login-entry.skip_discovery_if_only_one_tenant'],
      redirect_tenant_discover_to_common_entry:
        settings['login-entry.redirect_tenant_discover_to_common_entry'],
    });

    const tenantApp = createTenantSystemDiscoveryApp('first');
    const tenantResponse = await tenantApp.request(
      makeTenantRequest(makeTenantHost(row.topology, 'first'), '/api/auth/discovery'),
      {},
      env
    );
    await expectDiscoveryConfig(tenantResponse, {
      mode: settings['login-entry.mode'],
      discovery_methods: expectedMethods,
      email_resolution_policy: settings['login-entry.email_resolution_policy'],
      selection_policy: settings['login-entry.selection_policy'],
    });
  });
});
