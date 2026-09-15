import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TENANT_DATASET_POLICIES } from '../dataset-registry';
import { PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '../phase5-sqlite-modules';
import {
  PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE8_SQLITE_DATASET_REGISTRATIONS,
  PHASE8_SQLITE_KINDS,
} from '../phase8-sqlite-modules';
import { selectInstalledSqliteDatasets } from '../installed-sqlite-datasets';

const selection = {
  settings: false,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 30 as const },
};

describe('Phase 8 SQLite modules', () => {
  it('pins the reviewed selectable SQL inventory without duplicates', () => {
    expect(PHASE8_SQLITE_DATASET_REGISTRATIONS).toHaveLength(184);
    expect(PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS).toHaveLength(299);
    expect(
      new Set(PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)).size
    ).toBe(PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length);
    expect(
      createHash('sha256').update(JSON.stringify(PHASE8_SQLITE_DATASET_REGISTRATIONS)).digest('hex')
    ).toBe('f77fed09a4f33f5ea4b50394d48581931709835c8dbc6511d5bd89c99ac388f7');
  });

  it('covers every reviewed Phase 8 SQL classification exactly once', () => {
    const phase5Tables = new Set(
      PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(
        ({ family, table }) => `${family}:${table}`
      )
    );
    const expected = TENANT_DATASET_POLICIES.filter(
      ({ family, table, kind }) =>
        PHASE8_SQLITE_KINDS.includes(kind as never) &&
        family !== 'plugin_runner' &&
        !phase5Tables.has(`${family}:${table}`)
    )
      .map(({ family, table }) => `${family}.${table}`)
      .concat('core.resource_permissions.users')
      .sort();
    expect(PHASE8_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)).toEqual(expected);
  });

  it('keeps independently selected categories separate and always resolves dependencies', () => {
    const users = selectInstalledSqliteDatasets(PHASE8_SQLITE_DATASET_REGISTRATIONS, {
      ...selection,
      users: true,
    });
    expect(users.some(({ kind }) => kind === 'users')).toBe(true);
    expect(users.some(({ kind }) => kind === 'admin')).toBe(false);
    expect(users.some(({ kind }) => kind === 'audit' || kind === 'history')).toBe(false);
    expect(users.some(({ kind }) => kind === 'artifacts' || kind === 'log_dependencies')).toBe(
      true
    );

    const admin = selectInstalledSqliteDatasets(PHASE8_SQLITE_DATASET_REGISTRATIONS, {
      ...selection,
      admin: true,
    });
    expect(admin.some(({ kind }) => kind === 'admin')).toBe(true);
    expect(admin.some(({ kind }) => kind === 'users')).toBe(false);

    const logs = selectInstalledSqliteDatasets(PHASE8_SQLITE_DATASET_REGISTRATIONS, {
      ...selection,
      logs: { audit: true, other: true, sensitive: true, period: 90 },
    });
    expect(logs.some(({ kind }) => kind === 'audit')).toBe(true);
    expect(logs.some(({ kind }) => kind === 'history')).toBe(true);
    expect(logs.some(({ kind }) => kind === 'sensitive_logs')).toBe(true);
  });

  it('does not register sessions, transient authentication, rebuild or external state', () => {
    const ids = PHASE8_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id);
    expect(ids).not.toContain('core.sessions');
    expect(ids).not.toContain('core.user_token_families');
    expect(ids).not.toContain('admin.admin_sessions');
    expect(ids).not.toContain('admin.admin_passkeys');
    expect(ids).not.toContain('core.password_reset_tokens');
    expect(ids).not.toContain('admin.tenant_database_registry');
    expect(ids).not.toContain('admin.admin_database_connections');
    expect(ids).not.toContain('control.control_audit_events');
    expect(ids).not.toContain('control.control_account_legal_hold_projections');
    expect(ids).not.toContain('plugin_runner.plugin_runner_egress_audit');
    expect(ids).toContain('pii.identity_identifier_replacement_challenges');
    expect(
      PHASE8_SQLITE_DATASET_REGISTRATIONS.some(({ dataset }) =>
        ['ephemeral', 'rebuild', 'external', 'tenant_state'].includes(dataset.kind)
      )
    ).toBe(false);
  });
});
