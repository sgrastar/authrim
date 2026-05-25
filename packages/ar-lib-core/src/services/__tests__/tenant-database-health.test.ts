import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter, HealthStatus } from '../../db/adapter';
import {
  checkResolvedTenantDatabaseDeepHealth,
  checkResolvedTenantDatabaseHealth,
  DEFAULT_TENANT_DATABASE_LIGHT_HEALTH_INTERVAL_SECONDS,
  readTenantDatabaseAppliedSchemaVersion,
} from '../tenant-database-health';
import type { ResolvedTenantStore } from '../tenant-database-resolver';

function adapterWithHealth(
  health: HealthStatus,
  options: {
    migrations?: string[];
    queryError?: Error;
  } = {}
): DatabaseAdapter {
  return {
    query: async () => {
      if (options.queryError) {
        throw options.queryError;
      }
      return (options.migrations ?? []).map((filename) => ({ filename }));
    },
    queryOne: async () => null,
    execute: async () => ({ rowsAffected: 0, success: true }),
    transaction: async (callback) =>
      callback({
        query: async () => [],
        queryOne: async () => null,
        execute: async () => ({ rowsAffected: 0, success: true }),
      }),
    batch: async () => [],
    isHealthy: async () => health,
    getType: () => health.type,
    close: async () => {},
  };
}

function resolvedStore(
  source: DatabaseAdapter,
  healthStatus: ResolvedTenantStore['healthStatus'],
  schemaVersion: number = 1
) {
  return {
    tenantId: 'tenant-a',
    role: 'tenant_core',
    source,
    generation: 2,
    runtimeGeneration: 3,
    schemaVersion,
    shardGroup: 'default',
    shardIndex: 0,
    shardCount: 1,
    shardKeyStrategy: 'none',
    driver: 'd1',
    bindingRef: 'TDB_TENANT_A_ABC123_CORE',
    deploymentTarget: null,
    healthStatus,
    registryRow: {} as ResolvedTenantStore['registryRow'],
  } satisfies ResolvedTenantStore;
}

describe('tenant database health', () => {
  it('uses a five minute default lightweight health interval', () => {
    expect(DEFAULT_TENANT_DATABASE_LIGHT_HEALTH_INTERVAL_SECONDS).toBe(300);
  });

  it('reports healthy for active stores whose adapter is healthy', async () => {
    const result = await checkResolvedTenantDatabaseHealth(
      resolvedStore(adapterWithHealth({ healthy: true, latencyMs: 12, type: 'd1' }), 'active'),
      '2026-05-16T00:00:00.000Z'
    );

    expect(result).toMatchObject({
      tenantId: 'tenant-a',
      role: 'tenant_core',
      bindingRef: 'TDB_TENANT_A_ABC123_CORE',
      severity: 'healthy',
      latencyMs: 12,
      checkedAt: '2026-05-16T00:00:00.000Z',
    });
  });

  it('preserves degraded state and fails when the adapter health check fails', async () => {
    const degraded = await checkResolvedTenantDatabaseHealth(
      resolvedStore(adapterWithHealth({ healthy: true, latencyMs: 9, type: 'd1' }), 'degraded'),
      '2026-05-16T00:00:00.000Z'
    );
    expect(degraded.severity).toBe('degraded');

    const failed = await checkResolvedTenantDatabaseHealth(
      resolvedStore(
        adapterWithHealth({ healthy: false, latencyMs: 20, type: 'd1', error: 'timeout' }),
        'active'
      ),
      '2026-05-16T00:00:00.000Z'
    );
    expect(failed.severity).toBe('failed');
    expect(failed.error).toBe('timeout');
  });

  it('reads the highest applied tenant database migration version', async () => {
    const version = await readTenantDatabaseAppliedSchemaVersion(
      adapterWithHealth(
        { healthy: true, latencyMs: 1, type: 'd1' },
        {
          migrations: [
            '001_core_foundation.sql',
            '006_core_extended_operations.sql',
            'invalid.sql',
          ],
        }
      )
    );

    expect(version).toBe(6);
  });

  it('reports deep health as healthy when registry and database schema versions match', async () => {
    const result = await checkResolvedTenantDatabaseDeepHealth(
      resolvedStore(
        adapterWithHealth(
          { healthy: true, latencyMs: 12, type: 'd1' },
          {
            migrations: ['006_core_extended_operations.sql'],
          }
        ),
        'active',
        6
      ),
      '2026-05-16T00:00:00.000Z'
    );

    expect(result).toMatchObject({
      severity: 'healthy',
      registrySchemaVersion: 6,
      databaseSchemaVersion: 6,
      schemaDrift: 'none',
    });
  });

  it('fails deep health when database schema is behind the registry', async () => {
    const result = await checkResolvedTenantDatabaseDeepHealth(
      resolvedStore(
        adapterWithHealth(
          { healthy: true, latencyMs: 12, type: 'd1' },
          {
            migrations: ['005_core_indexes_and_log_objects.sql'],
          }
        ),
        'active',
        6
      ),
      '2026-05-16T00:00:00.000Z'
    );

    expect(result).toMatchObject({
      severity: 'failed',
      registrySchemaVersion: 6,
      databaseSchemaVersion: 5,
      schemaDrift: 'behind_registry',
      error: 'tenant_database_schema_version_too_old:5<6',
    });
  });

  it('marks non-blocking schema drift as degraded when database schema is ahead', async () => {
    const result = await checkResolvedTenantDatabaseDeepHealth(
      resolvedStore(
        adapterWithHealth(
          { healthy: true, latencyMs: 12, type: 'd1' },
          {
            migrations: ['088_future.sql'],
          }
        ),
        'active',
        87
      ),
      '2026-05-16T00:00:00.000Z'
    );

    expect(result).toMatchObject({
      severity: 'degraded',
      registrySchemaVersion: 87,
      databaseSchemaVersion: 88,
      schemaDrift: 'ahead_of_registry',
      error: 'tenant_database_schema_version_ahead:88>87',
    });
  });

  it('fails deep health when schema version cannot be read', async () => {
    const result = await checkResolvedTenantDatabaseDeepHealth(
      resolvedStore(
        adapterWithHealth(
          { healthy: true, latencyMs: 12, type: 'd1' },
          { queryError: new Error('no such table: authrim_migrations') }
        ),
        'active',
        87
      ),
      '2026-05-16T00:00:00.000Z'
    );

    expect(result).toEqual(
      expect.objectContaining({
        severity: 'failed',
        databaseSchemaVersion: null,
        schemaDrift: 'unknown',
        error: 'tenant_database_schema_version_unreadable:no such table: authrim_migrations',
      })
    );
  });
});
