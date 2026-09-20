import { describe, expect, it } from 'vitest';
import {
  assertEnvironmentTenantKey,
  assertPortableTenantKeyRow,
  normalizePortableTenantKeyRow,
  portableTenantKeyColumn,
  PORTABLE_TENANT_KEY,
} from '../portable-tenant-key.js';
import type { SnapshotTableSchema } from '../sqlite-snapshot.js';

const direct: SnapshotTableSchema = {
  table: 'log_chunk_record_index',
  columns: ['tenant_key', 'record_id'],
  primaryKey: ['tenant_key', 'record_id'],
  uniqueKeys: [],
  tenantColumn: 'tenant_key',
  tenantIdentity: 'tenantKey',
};

const tenant: SnapshotTableSchema = {
  table: 'tenants',
  columns: ['id', 'tenant_key'],
  primaryKey: ['id'],
  uniqueKeys: [['tenant_key']],
  tenantColumn: 'id',
};

describe('portable tenant key rows', () => {
  it('normalizes direct ownership and tenant metadata without carrying the source key', () => {
    for (const schema of [direct, tenant]) {
      const normalized = normalizePortableTenantKeyRow(
        schema,
        JSON.stringify({
          [schema.tenantColumn]: ['text', schema === direct ? 'source-key' : 'tenant-a'],
          tenant_key: ['text', 'source-key'],
          record_id: ['text', 'record-a'],
        }),
        'source-key',
        true
      );
      expect(normalized).not.toContain('source-key');
      expect(JSON.parse(normalized).tenant_key).toEqual(['text', PORTABLE_TENANT_KEY]);
      expect(() => assertPortableTenantKeyRow(schema, JSON.parse(normalized), true)).not.toThrow();
    }
  });

  it('preserves an optional null key but rejects missing, malformed, or foreign keys', () => {
    const optional = { ...tenant, table: 'logging_usage_aggregates' };
    const row = JSON.stringify({ id: ['text', 'usage-a'], tenant_key: ['null', null] });
    expect(normalizePortableTenantKeyRow(optional, row, 'source-key', false)).toBe(row);
    expect(() => assertPortableTenantKeyRow(optional, JSON.parse(row), false)).not.toThrow();
    expect(() => normalizePortableTenantKeyRow(optional, row, 'source-key', true)).toThrow(
      'backup_portable_tenant_key_invalid'
    );
    for (const value of [undefined, ['text', 'another-key'], ['integer', '1'], 'source-key']) {
      expect(() =>
        normalizePortableTenantKeyRow(
          optional,
          JSON.stringify({ id: ['text', 'usage-a'], tenant_key: value }),
          'source-key',
          false
        )
      ).toThrow('backup_portable_tenant_key_invalid');
    }
  });

  it('finds only installed schemas that actually carry a tenant key', () => {
    expect(portableTenantKeyColumn(direct)).toBe('tenant_key');
    expect(portableTenantKeyColumn(tenant)).toBe('tenant_key');
    expect(portableTenantKeyColumn({ ...tenant, columns: ['id'], uniqueKeys: [] })).toBeUndefined();
  });

  it('never accepts the portable marker as a live environment key', () => {
    expect(assertEnvironmentTenantKey('environment-key')).toBe('environment-key');
    for (const value of [PORTABLE_TENANT_KEY, '', 'contains space'])
      expect(() => assertEnvironmentTenantKey(value)).toThrow('backup_portable_tenant_key_invalid');
  });
});
