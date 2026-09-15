import { describe, expect, it } from 'vitest';
import { TENANT_DATASET_POLICIES } from '../dataset-registry';
import { getTenantRuntimeRegistryRouteState } from '../../tenant-runtime-registry-snapshot';
import type { TenantRuntimeCacheGenerationRow } from '../../../repositories/admin/tenant-database-registry';
import {
  parseTenantBackupSelection,
  tenantBackupLogWindow,
  tenantDatasetSelectionRule,
  type TenantBackupSelection,
} from '../selection-contract';

function usersOnly(): TenantBackupSelection {
  return {
    settings: false,
    users: true,
    admin: false,
    logs: { audit: false, other: false, sensitive: false, period: 30 },
    artifacts: false,
  };
}

describe('tenant portability selection contract', () => {
  it.each(['settings', 'users', 'admin', 'logs'] as const)(
    'keeps tenant denial state when only %s is selected',
    (category) => {
      const selection = parseTenantBackupSelection({
        settings: category === 'settings',
        users: category === 'users',
        admin: category === 'admin',
        logs: { audit: category === 'logs', other: false, sensitive: false, period: 7 },
        artifacts: false,
      });
      const policy = TENANT_DATASET_POLICIES.find(
        (entry) => entry.family === 'admin' && entry.table === 'tenant_runtime_cache_generations'
      )!;
      expect(tenantDatasetSelectionRule(policy.kind, selection)).toEqual({
        action: 'selected',
        timeFilter: 'none',
      });
      const state: TenantRuntimeCacheGenerationRow = {
        tenant_id: 'tenant-a',
        cache_namespace: 'runtime_registry',
        generation: 12,
        updated_by: null,
        updated_at: '2026-09-14T00:00:00Z',
        metadata_json: JSON.stringify({
          route_status: 'quarantined',
          quarantine_deny_generation: 7,
        }),
      };
      expect(getTenantRuntimeRegistryRouteState(state)).toEqual({
        routeStatus: 'quarantined',
        quarantineDenyGeneration: 7,
      });
      // Omitting the row is not a safe reconstruction: the production reader defaults active.
      expect(getTenantRuntimeRegistryRouteState(null).routeStatus).toBe('active');
    }
  );
  it.each(['settings', 'users', 'admin'] as const)(
    'allows %s without silently including other categories',
    (category) => {
      const input = usersOnly();
      input.users = false;
      input[category] = true;
      const selection = parseTenantBackupSelection(input);
      for (const candidate of ['settings', 'users', 'admin'] as const) {
        expect(tenantDatasetSelectionRule(candidate, selection)).toEqual(
          candidate === category
            ? { action: 'selected', timeFilter: 'none' }
            : { action: 'excluded', reason: 'not_selected' }
        );
      }
    }
  );

  it('keeps tombstones and failed write guards but excludes refresh-token families', () => {
    const selection = parseTenantBackupSelection(usersOnly());
    for (const table of [
      'users_pii_tombstone',
      'service_group_write_boundaries',
      'account_legal_hold_states',
    ]) {
      const policies = TENANT_DATASET_POLICIES.filter((policy) => policy.table === table);
      expect(policies.length).toBeGreaterThan(0);
      for (const policy of policies) {
        expect(tenantDatasetSelectionRule(policy.kind, selection)).toEqual({
          action: 'selected',
          timeFilter: 'none',
        });
      }
    }
    expect(tenantDatasetSelectionRule('audit', selection).action).toBe('excluded');
    expect(tenantDatasetSelectionRule('history', selection).action).toBe('excluded');
    const tokenFamilies = TENANT_DATASET_POLICIES.filter(
      (policy) => policy.table === 'user_token_families'
    );
    expect(tokenFamilies).toHaveLength(1);
    expect(tenantDatasetSelectionRule(tokenFamilies[0]!.kind, selection)).toEqual({
      action: 'excluded',
      reason: 'ephemeral',
    });
    expect(tenantDatasetSelectionRule('ephemeral', selection)).toEqual({
      action: 'excluded',
      reason: 'ephemeral',
    });
  });

  it('resolves required bodies and live delivery state without blanket catalog copying', () => {
    for (const artifacts of [false, true]) {
      const selection = { ...usersOnly(), artifacts };
      for (const [kind, purpose] of [
        ['artifacts', 'artifacts'],
        ['log_dependencies', 'logs'],
        ['delivery_state', 'delivery_state'],
      ] as const) {
        expect(tenantDatasetSelectionRule(kind, selection)).toEqual({
          action: 'resolve_references',
          purpose,
        });
      }
    }
  });

  it.each(['audit', 'other', 'sensitive'] as const)(
    'selects %s logs independently and preserves the common fixed window',
    (log) => {
      const input = usersOnly();
      input.users = false;
      input.logs[log] = true;
      const selection = parseTenantBackupSelection(input);
      for (const [option, kind] of [
        ['audit', 'audit'],
        ['other', 'history'],
        ['sensitive', 'sensitive_logs'],
      ] as const) {
        expect(tenantDatasetSelectionRule(kind, selection)).toEqual(
          option === log
            ? { action: 'selected', timeFilter: 'log_window' }
            : { action: 'excluded', reason: 'not_selected' }
        );
      }
    }
  );

  it('rejects malformed, empty and unknown selection options', () => {
    for (const value of [
      null,
      [],
      {},
      { ...usersOnly(), users: 'true' },
      { ...usersOnly(), users: false },
      { ...usersOnly(), includeSecrets: true },
      { ...usersOnly(), logs: { ...usersOnly().logs, period: '30' } },
      { ...usersOnly(), logs: { ...usersOnly().logs, period: 365 } },
      { ...usersOnly(), logs: { ...usersOnly().logs, startDate: '2026-01-01' } },
    ]) {
      expect(() => parseTenantBackupSelection(value)).toThrow('invalid_tenant_backup_selection');
    }
  });

  it('detaches the parsed selection from the caller', () => {
    const input = usersOnly();
    const selection = parseTenantBackupSelection(input);
    input.users = false;
    input.logs.sensitive = true;
    expect(selection).toEqual(usersOnly());
  });

  it('pins all log cutoffs to a supplied snapshot boundary', () => {
    const boundary = 1_800_000_000_000;
    for (const period of [7, 30, 90] as const) {
      expect(tenantBackupLogWindow(period, boundary)).toEqual({
        fromInclusiveUnixMs: boundary - period * 86_400_000,
        untilInclusiveUnixMs: boundary,
      });
    }
    expect(tenantBackupLogWindow('all', boundary)).toEqual({
      fromInclusiveUnixMs: null,
      untilInclusiveUnixMs: boundary,
    });
    for (const invalid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => tenantBackupLogWindow(7, invalid)).toThrow('invalid_tenant_backup_selection');
    }
  });
});
