import { describe, expect, it } from 'vitest';
import {
  MIGRATION_STREAM_CONTRACTS,
  migrationRendererDialect,
  migrationStreamIdForControlDataRole,
  migrationStreamContract,
  requireMigrationStreamId,
  resolveMigrationStreamId,
} from '../migration-stream-contract.js';

describe('migration stream contract', () => {
  it('keeps schema family, dialect, target kind, and directory independent', () => {
    expect(MIGRATION_STREAM_CONTRACTS).toEqual([
      expect.objectContaining({
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        directory: 'core/d1',
      }),
      expect.objectContaining({
        id: 'pii-d1',
        schemaFamily: 'pii',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        directory: 'pii/d1',
      }),
      expect.objectContaining({ id: 'admin-d1', directory: 'admin/d1' }),
      expect.objectContaining({ id: 'control-d1', directory: 'control/d1' }),
      expect.objectContaining({ id: 'lookup-d1', directory: 'lookup/d1' }),
      expect.objectContaining({ id: 'plugin-runner-d1', directory: 'plugin-runner/d1' }),
      expect.objectContaining({
        id: 'core-postgresql',
        schemaFamily: 'core',
        dialect: 'postgresql',
        targetKind: 'postgresql-connection',
        directory: 'core/postgresql',
      }),
      expect.objectContaining({
        id: 'pii-postgresql',
        schemaFamily: 'pii',
        dialect: 'postgresql',
        targetKind: 'postgresql-connection',
        directory: 'pii/postgresql',
      }),
    ]);
  });

  it('resolves a logical role only within the requested target kind', () => {
    expect(resolveMigrationStreamId({ logicalRole: 'core', targetKind: 'cloudflare-d1' })).toBe(
      'core-d1'
    );
    expect(
      resolveMigrationStreamId({ logicalRole: 'core', targetKind: 'postgresql-connection' })
    ).toBe('core-postgresql');
    expect(
      resolveMigrationStreamId({ logicalRole: 'lookup', targetKind: 'postgresql-connection' })
    ).toBeNull();
  });

  it('requires a supported role and target pair without backend fallback', () => {
    expect(
      requireMigrationStreamId({ logicalRole: 'tenant_pii', targetKind: 'cloudflare-d1' })
    ).toBe('pii-d1');
    expect(() =>
      requireMigrationStreamId({ logicalRole: 'lookup', targetKind: 'postgresql-connection' })
    ).toThrow('migration_stream_role_not_found:lookup:postgresql-connection');
  });

  it('maps Control physical data roles through the same canonical contract', () => {
    expect(migrationStreamIdForControlDataRole('tenant_core/default')).toBe('core-d1');
    expect(migrationStreamIdForControlDataRole('tenant_core/users')).toBe('core-d1');
    expect(migrationStreamIdForControlDataRole('tenant_pii')).toBe('pii-d1');
    expect(migrationStreamIdForControlDataRole('lookup')).toBe('lookup-d1');
  });

  it('maps public manifest dialects to the internal SQL renderer explicitly', () => {
    expect(migrationRendererDialect('sqlite')).toBe('sqlite');
    expect(migrationRendererDialect('postgresql')).toBe('postgres');
    expect(migrationStreamContract('core-postgresql').dialect).toBe('postgresql');
  });
});
