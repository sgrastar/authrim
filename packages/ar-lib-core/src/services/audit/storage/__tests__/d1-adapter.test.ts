import { describe, expect, it, vi } from 'vitest';
import type { EventLogEntry, PIILogEntry } from '../../types';
import { D1AuditAdapter } from '../d1-adapter';

function createEventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    eventType: 'auth.login',
    eventCategory: 'authentication',
    result: 'success',
    severity: 'info',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createPiiEntry(overrides: Partial<PIILogEntry> = {}): PIILogEntry {
  return {
    id: 'pii-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    anonymizedUserId: 'anon-1',
    changeType: 'update',
    affectedFields: 'email',
    encryptionKeyId: 'key-1',
    encryptionIv: 'iv-1',
    actorType: 'user',
    retentionUntil: 1_800_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('D1AuditAdapter', () => {
  it('refuses retired writeEventLogBatch instead of creating an old primary copy', async () => {
    const bind = vi.fn().mockReturnValue({ kind: 'bound' });
    const prepare = vi.fn().mockReturnValue({ bind });
    const batch = vi.fn().mockResolvedValue([]);
    const adapter = new D1AuditAdapter({
      id: 'audit-d1',
      db: { prepare, batch } as unknown as D1Database,
      isPiiDb: false,
    });

    await expect(adapter.writeEventLogBatch([createEventEntry()])).rejects.toThrow(
      'audit_primary_storage_retired_use_configured_iceberg_mode'
    );
  });

  it('refuses retired writePIILogBatch instead of creating an old primary copy', async () => {
    const bind = vi.fn().mockReturnValue({ kind: 'bound' });
    const prepare = vi.fn().mockReturnValue({ bind });
    const batch = vi.fn().mockResolvedValue([]);
    const adapter = new D1AuditAdapter({
      id: 'audit-d1',
      db: { prepare, batch } as unknown as D1Database,
      isPiiDb: true,
    });

    await expect(adapter.writePIILogBatch([createPiiEntry()])).rejects.toThrow(
      'audit_primary_storage_retired_use_configured_iceberg_mode'
    );
  });

  it('lists retention candidates in stable oldest-first order and deletes through an ordered subquery', async () => {
    const bind = vi.fn();
    const all = vi.fn().mockResolvedValue({
      results: [
        {
          id: 'evt-1',
          tenant_id: 'tenant-1',
          event_type: 'auth.login',
          event_category: 'authentication',
          result: 'success',
          severity: 'info',
          error_code: null,
          error_message: null,
          anonymized_user_id: null,
          client_id: null,
          session_id: null,
          request_id: null,
          duration_ms: null,
          details_r2_key: null,
          details_json: null,
          retention_until: 1_690_000_000_000,
          created_at: 1_700_000_000_000,
        },
      ],
    });
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    bind.mockReturnValueOnce({ all }).mockReturnValueOnce({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const adapter = new D1AuditAdapter({
      id: 'audit-d1',
      db: { prepare } as unknown as D1Database,
      isPiiDb: false,
    });

    const candidates = await adapter.listTenantRetentionCandidates(
      'event',
      1_700_000_000_000,
      'tenant-1',
      50
    );
    const deleted = await adapter.deleteTenantByRetention(
      'event',
      1_700_000_000_000,
      'tenant-1',
      50
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        id: 'evt-1',
        retentionUntil: 1_690_000_000_000,
      }),
    ]);
    expect(prepare.mock.calls[0]?.[0]).toContain(
      'ORDER BY retention_until ASC, created_at ASC, id ASC'
    );
    expect(prepare.mock.calls[1]?.[0]).toContain('WHERE id IN');
    expect(prepare.mock.calls[1]?.[0]).toContain(
      'ORDER BY retention_until ASC, created_at ASC, id ASC'
    );
    expect(deleted).toBe(1);
  });

  it('reports a failed retention read or delete instead of nothing to delete', async () => {
    const failure = new Error('D1_ERROR: database unavailable');
    const bind = vi.fn().mockReturnValue({
      all: vi.fn().mockRejectedValue(failure),
      run: vi.fn().mockRejectedValue(failure),
    });
    const adapter = new D1AuditAdapter({
      id: 'audit-d1',
      db: { prepare: vi.fn().mockReturnValue({ bind }) } as unknown as D1Database,
      isPiiDb: false,
    });

    await expect(
      adapter.listTenantRetentionCandidates('event', Date.now(), 'tenant-1')
    ).rejects.toThrow(failure);
    await expect(adapter.deleteTenantByRetention('pii', Date.now(), 'tenant-1')).rejects.toThrow(
      failure
    );
  });
});
