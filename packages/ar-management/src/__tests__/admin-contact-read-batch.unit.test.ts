import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { AdminContactReadBatch } from '../admin-contact-read-batch';

function externalSource(rows: unknown[] = [{ id: 'contact-1' }]) {
  const query = vi.fn(async () => rows);
  const source = {
    query,
    queryOne: vi.fn(),
    execute: vi.fn(),
    batch: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'postgresql'),
  } as unknown as DatabaseAdapter;
  return { source, query };
}

function d1Source() {
  const bind = vi.fn((sql: string, params: unknown[]) => ({ sql, params }));
  const prepare = vi.fn((sql: string) => ({ bind: (...params: unknown[]) => bind(sql, params) }));
  const batch = vi.fn(
    async (
      statements: Array<{ sql: string; params: unknown[] }>
    ): Promise<Array<{ success: boolean; results: unknown[] }>> =>
      statements.map((statement) => ({ success: true, results: [statement] }))
  );
  const session = { prepare, batch };
  const withSession = vi.fn(() => session);
  const source = {
    prepare: vi.fn(),
    batch: vi.fn(),
    withSession,
  } as unknown as D1Database;
  return { source, withSession, prepare, bind, batch };
}

describe('AdminContactReadBatch', () => {
  it('caches a read-only adapter per source and keeps writes out of it', () => {
    const { source, query } = externalSource();
    const batch = new AdminContactReadBatch();
    const adapter = batch.adapter(source);

    expect(batch.adapter(source)).toBe(adapter);
    expect(() => adapter.execute('DELETE FROM contact_points')).toThrow(
      'admin_contact_read_adapter_is_read_only'
    );
    expect(() => adapter.batch([])).toThrow('admin_contact_read_adapter_is_read_only');
    expect(() => adapter.transaction(async () => undefined)).toThrow(
      'admin_contact_read_adapter_is_read_only'
    );
    expect(() => adapter.close()).toThrow('admin_contact_read_adapter_is_read_only');
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    'UPDATE contact_points SET value = ?',
    'WITH records AS (SELECT 1) SELECT * FROM records',
    '',
  ])('rejects a non-SELECT statement before opening the database: %s', async (sql) => {
    const { source, query } = externalSource();
    await expect(new AdminContactReadBatch().adapter(source).query(sql)).rejects.toThrow(
      'admin_contact_read_query_invalid'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects excessive bound parameters before opening the database', async () => {
    const { source, query } = externalSource();
    await expect(
      new AdminContactReadBatch().adapter(source).query('SELECT ?', Array(101).fill('value'))
    ).rejects.toThrow('admin_contact_read_query_invalid');
    expect(query).not.toHaveBeenCalled();
  });

  it('passes primary-consistent reads to external adapters and selects the first row for queryOne', async () => {
    const { source, query } = externalSource([{ id: 'first' }, { id: 'second' }]);
    const adapter = new AdminContactReadBatch().adapter(source);

    const [all, first] = await Promise.all([
      adapter.query<{ id: string }>(' SELECT id FROM contact_points WHERE tenant_id = ?', [
        'tenant-a',
      ]),
      adapter.queryOne<{ id: string }>('SELECT id FROM contact_points WHERE tenant_id = ?', [
        'tenant-b',
      ]),
    ]);

    expect(all).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(first).toEqual({ id: 'first' });
    expect(query.mock.calls).toEqual([
      [
        ' SELECT id FROM contact_points WHERE tenant_id = ?',
        ['tenant-a'],
        { consistencyClass: 'primary_required' },
      ],
      [
        'SELECT id FROM contact_points WHERE tenant_id = ?',
        ['tenant-b'],
        { consistencyClass: 'primary_required' },
      ],
    ]);
  });

  it('uses one primary D1 session and batches at most 50 reads per statement group', async () => {
    const { source, withSession, prepare, bind, batch } = d1Source();
    const adapter = new AdminContactReadBatch().adapter(source);

    const rows = await Promise.all(
      Array.from({ length: 51 }, (_, index) =>
        adapter.query<{ sql: string; params: unknown[] }>(
          'SELECT id FROM contact_points WHERE id = ?',
          [index]
        )
      )
    );

    expect(rows[0]).toEqual([{ sql: 'SELECT id FROM contact_points WHERE id = ?', params: [0] }]);
    expect(rows[50]).toEqual([{ sql: 'SELECT id FROM contact_points WHERE id = ?', params: [50] }]);
    expect(withSession).toHaveBeenCalledExactlyOnceWith('first-primary');
    expect(prepare).toHaveBeenCalledTimes(51);
    expect(bind).toHaveBeenCalledTimes(51);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls.map((call) => call[0].length)).toEqual([50, 1]);
  });

  it('rejects the entire D1 round when a batch has a failed or malformed result', async () => {
    const { source, batch } = d1Source();
    batch.mockResolvedValueOnce([
      { success: true, results: [{ id: 'contact-1' }] },
      { success: false, results: [] },
    ]);
    const adapter = new AdminContactReadBatch().adapter(source);
    const first = adapter.query('SELECT id FROM contact_points WHERE id = ?', ['contact-1']);
    const second = adapter.query('SELECT id FROM contact_points WHERE id = ?', ['contact-2']);

    await expect(first).rejects.toThrow('admin_contact_read_batch_failed');
    await expect(second).rejects.toThrow('admin_contact_read_batch_failed');
    await expect(adapter.query('SELECT id FROM contact_points')).rejects.toThrow(
      'admin_contact_read_batch_failed'
    );
    expect(batch).toHaveBeenCalledOnce();
  });

  it('keeps all sources in a round pending until the slowest source has finished', async () => {
    let releaseSlow!: (value: unknown[]) => void;
    const slow = externalSource();
    slow.query.mockImplementation(
      () => new Promise<unknown[]>((resolve) => (releaseSlow = resolve))
    );
    let fastRead!: () => void;
    const fastReadStarted = new Promise<void>((resolve) => (fastRead = resolve));
    const fast = externalSource();
    fast.query.mockImplementation(async () => {
      fastRead();
      return [{ id: 'fast' }];
    });
    const batch = new AdminContactReadBatch();
    let fastSettled = false;
    const first = batch
      .adapter(fast.source)
      .query('SELECT id FROM contact_points')
      .then((rows) => {
        fastSettled = true;
        return rows;
      });
    const second = batch.adapter(slow.source).query('SELECT id FROM contact_points');

    await fastReadStarted;
    await Promise.resolve();
    expect(fastSettled).toBe(false);
    releaseSlow([{ id: 'slow' }]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: 'fast' }],
      [{ id: 'slow' }],
    ]);
  });

  it('propagates one external-store failure to all reads and future requests', async () => {
    const { source, query } = externalSource();
    const failure = new Error('database unavailable');
    query.mockRejectedValue(failure);
    const adapter = new AdminContactReadBatch().adapter(source);
    const first = adapter.query('SELECT id FROM contact_points');
    const second = adapter.query('SELECT id FROM contact_points');

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(adapter.query('SELECT id FROM contact_points')).rejects.toBe(failure);
    expect(query).toHaveBeenCalledOnce();
  });
});
