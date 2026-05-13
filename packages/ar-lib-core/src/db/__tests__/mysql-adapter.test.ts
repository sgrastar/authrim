import { describe, expect, it, vi } from 'vitest';
import { MysqlAdapter } from '../adapters/mysql-adapter';

describe('MysqlAdapter', () => {
  it('preserves question-mark placeholders for mysql execution', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 1 }] });
    const adapter = new MysqlAdapter({
      connectionString: 'mysql://user:pass@example.com:3306/authrim',
      clientFactory: async () => ({
        query,
        execute: async () => ({ rows: [], affectedRows: 1 }),
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        end: async () => undefined,
      }),
    });

    const result = await adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM event_log WHERE tenant_id = ? AND event_type = ?',
      ['tenant-1', 'auth.login']
    );

    expect(result?.count).toBe(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT COUNT(*) as count FROM event_log WHERE tenant_id = ? AND event_type = ?',
      ['tenant-1', 'auth.login']
    );
  });

  it('wraps batch operations in a mysql transaction', async () => {
    const beginTransaction = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ rows: [], affectedRows: 1 });
    const adapter = new MysqlAdapter({
      connectionString: 'mysql://user:pass@example.com:3306/authrim',
      clientFactory: async () => ({
        query: async () => ({ rows: [] }),
        execute,
        beginTransaction,
        commit,
        rollback: async () => undefined,
        end: async () => undefined,
      }),
    });

    await adapter.batch([
      { sql: 'INSERT INTO event_log (id, tenant_id) VALUES (?, ?)', params: ['evt-1', 'tenant-1'] },
      { sql: 'DELETE FROM event_log WHERE id = ?', params: ['evt-1'] },
    ]);

    expect(beginTransaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenNthCalledWith(
      1,
      'INSERT INTO event_log (id, tenant_id) VALUES (?, ?)',
      ['evt-1', 'tenant-1']
    );
    expect(execute).toHaveBeenNthCalledWith(2, 'DELETE FROM event_log WHERE id = ?', ['evt-1']);
    expect(commit).toHaveBeenCalledOnce();
  });
});
