import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import { recordTenantRuntimeRegistrySnapshotSecurityEvent } from '../tenant-runtime-registry-security-events';

function createAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  let notificationLookupCount = 0;
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: 'event-1',
          tenant_id: 'tenant-a',
          category: 'storage_registry_security',
          event_type: 'tenant_runtime_registry_snapshot.verification_failed',
          severity: 'critical',
          status: 'pending',
          deduplication_key:
            'tenant_runtime_registry_snapshot:invalid_signature:tenant-a:edge-a:8:key-1',
          payload_json: '{}',
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: '2026-05-16T00:00:00.000Z',
          updated_at: '2026-05-16T00:00:00.000Z',
          delivered_at: null,
        });
      }
      return Promise.resolve(null);
    }),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
      })
    ),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
    ...overrides,
  };
}

describe('tenant-runtime-registry-security-events', () => {
  it('records audit, internal notification, and tenant security alert for snapshot verification failure', async () => {
    const adminAdapter = createAdapter();
    const securityAlertAdapter = createAdapter();

    const result = await recordTenantRuntimeRegistrySnapshotSecurityEvent(
      {
        tenantId: 'tenant-a',
        deploymentTarget: 'edge-a',
        snapshotKey: 'tenant:tenant-a:runtime-registry:snapshot:tenant:edge-a',
        reason: 'invalid_signature',
        signatureKeyId: 'key-1',
        runtimeGeneration: 8,
        role: 'tenant_core',
        source: 'runtime_resolver',
        now: new Date('2026-05-16T00:00:00.000Z'),
      },
      {
        adminAuditAdapter: adminAdapter,
        internalNotificationAdapter: adminAdapter,
        securityAlertAdapter,
      }
    );

    expect(result).toEqual({
      auditLogged: true,
      notificationEnqueued: true,
      securityAlertCreated: true,
      errors: [],
    });
    expect(adminAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining([
        'tenant_runtime_registry_snapshot.verification_failed',
        'tenant_runtime_registry_snapshot',
        'tenant:tenant-a:runtime-registry:snapshot:tenant:edge-a',
        'failure',
        'invalid_signature',
        'Runtime registry snapshot verification failed',
        'critical',
      ])
    );
    expect(adminAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        'tenant-a',
        'storage_registry_security',
        'tenant_runtime_registry_snapshot.verification_failed',
        'critical',
        'tenant_runtime_registry_snapshot:invalid_signature:tenant-a:edge-a:8:key-1',
      ])
    );
    expect(securityAlertAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO security_alerts'),
      expect.arrayContaining(['tenant-a', 'Runtime registry snapshot verification failed'])
    );
  });

  it('treats notification delivery failures as fail-open', async () => {
    const brokenAdapter = createAdapter({
      execute: vi.fn().mockRejectedValue(new Error('db_unavailable')),
    });

    const result = await recordTenantRuntimeRegistrySnapshotSecurityEvent(
      {
        tenantId: 'tenant-a',
        deploymentTarget: 'edge-a',
        snapshotKey: 'tenant:tenant-a:runtime-registry:snapshot:tenant:edge-a',
        reason: 'unsigned_snapshot',
        signatureKeyId: null,
        runtimeGeneration: 8,
      },
      {
        adminAuditAdapter: brokenAdapter,
        internalNotificationAdapter: brokenAdapter,
      }
    );

    expect(result.auditLogged).toBe(false);
    expect(result.notificationEnqueued).toBe(false);
    expect(result.securityAlertCreated).toBe(false);
    expect(result.errors).toEqual(['db_unavailable', 'db_unavailable']);
  });
});
