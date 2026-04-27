import { describe, expect, it, vi } from 'vitest';
import type { EventLogEntry } from '../../types';
import { MysqlAuditAdapter } from '../mysql-audit-adapter';

function createEventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    eventType: 'auth.login',
    eventCategory: 'auth',
    result: 'success',
    severity: 'info',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('MysqlAuditAdapter', () => {
  it('uses insert-if-not-exists writes for event batches', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], affectedRows: 1 });
    const adapter = new MysqlAuditAdapter({
      id: 'audit-mysql',
      hyperdrive: {
        host: 'mysql.example.com',
        user: 'worker',
        password: 'secret',
        database: 'authrim',
        port: 3306,
      } as Hyperdrive,
      isPiiDb: false,
      clientFactory: async () => ({
        query: async () => ({ rows: [] }),
        execute,
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        end: async () => undefined,
      }),
    });

    const result = await adapter.writeEventLogBatch([createEventEntry()]);

    expect(result.success).toBe(true);
    expect(result.entriesWritten).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toContain('INSERT INTO `event_log`');
    expect(execute.mock.calls[0]?.[0]).toContain('WHERE NOT EXISTS');
    expect(execute.mock.calls[0]?.[0]).not.toContain('ON DUPLICATE KEY');
  });

  it('uses MySQL retention cleanup with tenant scoping and limit', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], affectedRows: 5 });
    const adapter = new MysqlAuditAdapter({
      id: 'audit-mysql',
      hyperdrive: {
        host: 'mysql.example.com',
        user: 'worker',
        password: 'secret',
        database: 'authrim',
        port: 3306,
      } as Hyperdrive,
      isPiiDb: false,
      clientFactory: async () => ({
        query: async () => ({ rows: [] }),
        execute,
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        end: async () => undefined,
      }),
    });

    const deleted = await adapter.deleteByRetention('event', 1_700_000_000_000, 'tenant-1', 50);

    expect(deleted).toBe(5);
    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM `event_log` WHERE retention_until < ? AND tenant_id = ? LIMIT ?',
      [1_700_000_000_000, 'tenant-1', 50]
    );
  });
});
