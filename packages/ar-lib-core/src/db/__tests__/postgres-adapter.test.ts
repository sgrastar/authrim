import { describe, expect, it, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres-adapter';

describe('PostgresAdapter', () => {
  it('converts question-mark placeholders to postgres placeholders', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 1 }], rowCount: 1 });
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://user:pass@example.com:5432/authrim',
      clientFactory: async () => ({
        query,
        end: async () => undefined,
      }),
    });

    const result = await adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM event_log WHERE tenant_id = ? AND event_type = ?',
      ['tenant-1', 'auth.login']
    );

    expect(result?.count).toBe(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT COUNT(*) as count FROM event_log WHERE tenant_id = $1 AND event_type = $2',
      ['tenant-1', 'auth.login']
    );
  });

  it('wraps batch operations in a transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://user:pass@example.com:5432/authrim',
      clientFactory: async () => ({
        query,
        end: async () => undefined,
      }),
    });

    await adapter.batch([
      { sql: 'INSERT INTO event_log (id, tenant_id) VALUES (?, ?)', params: ['evt-1', 'tenant-1'] },
      { sql: 'DELETE FROM event_log WHERE id = ?', params: ['evt-1'] },
    ]);

    expect(query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(query.mock.calls[1]?.[0]).toBe('INSERT INTO event_log (id, tenant_id) VALUES ($1, $2)');
    expect(query.mock.calls[2]?.[0]).toBe('DELETE FROM event_log WHERE id = $1');
    expect(query.mock.calls[3]?.[0]).toBe('COMMIT');
  });
});
