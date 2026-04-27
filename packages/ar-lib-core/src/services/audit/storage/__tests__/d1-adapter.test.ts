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
  it('uses insert-if-not-exists SQL for event writes', async () => {
    const bind = vi.fn().mockReturnValue({ kind: 'bound' });
    const prepare = vi.fn().mockReturnValue({ bind });
    const batch = vi.fn().mockResolvedValue([]);
    const adapter = new D1AuditAdapter({
      id: 'audit-d1',
      db: { prepare, batch } as unknown as D1Database,
      isPiiDb: false,
    });

    const result = await adapter.writeEventLogBatch([createEventEntry()]);

    expect(result.success).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toContain('WHERE NOT EXISTS');
    expect(prepare.mock.calls[0]?.[0]).not.toContain('ON CONFLICT');
    expect(bind).toHaveBeenCalledWith(
      'evt-1',
      'tenant-1',
      'auth.login',
      'authentication',
      'success',
      'info',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1_700_000_000_000,
      'evt-1'
    );
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('uses insert-if-not-exists SQL for pii writes', async () => {
    const bind = vi.fn().mockReturnValue({ kind: 'bound' });
    const prepare = vi.fn().mockReturnValue({ bind });
    const batch = vi.fn().mockResolvedValue([]);
    const adapter = new D1AuditAdapter({
      id: 'audit-d1',
      db: { prepare, batch } as unknown as D1Database,
      isPiiDb: true,
    });

    const result = await adapter.writePIILogBatch([createPiiEntry()]);

    expect(result.success).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toContain('WHERE NOT EXISTS');
    expect(prepare.mock.calls[0]?.[0]).not.toContain('ON CONFLICT');
    expect(bind).toHaveBeenCalledWith(
      'pii-1',
      'tenant-1',
      'user-1',
      'anon-1',
      'update',
      'email',
      null,
      null,
      'key-1',
      'iv-1',
      null,
      'user',
      null,
      null,
      null,
      1_800_000_000_000,
      1_700_000_000_000,
      'pii-1'
    );
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
