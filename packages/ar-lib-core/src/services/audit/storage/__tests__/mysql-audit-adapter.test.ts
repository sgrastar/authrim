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
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toContain('DELETE target');
    expect(execute.mock.calls[0]?.[0]).toContain('INNER JOIN');
    expect(execute.mock.calls[0]?.[0]).toContain('ORDER BY retention_until ASC, created_at ASC, id ASC');
    expect(execute.mock.calls[0]?.[1]).toEqual([1_700_000_000_000, 'tenant-1', 50]);
  });

  it('lists retention candidates in stable oldest-first order', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'evt-1',
          tenant_id: 'tenant-1',
          event_type: 'auth.login',
          event_category: 'auth',
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
        query,
        execute: async () => ({ rows: [], affectedRows: 0 }),
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        end: async () => undefined,
      }),
    });

    const rows = await adapter.listRetentionCandidates('event', 1_700_000_000_000, 'tenant-1', 25);

    expect(rows).toEqual([expect.objectContaining({ id: 'evt-1' })]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY retention_until ASC, created_at ASC, id ASC');
    expect(query.mock.calls[0]?.[0]).toContain('FROM `event_log`');
  });
});
