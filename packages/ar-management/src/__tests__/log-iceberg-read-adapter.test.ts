import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
const mocks = vi.hoisted(() => ({ read: vi.fn(), detail: vi.fn() }));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-read', () => ({
  readLogIcebergDataset: mocks.read,
  loadLogIcebergProtectedDetail: mocks.detail,
}));
import {
  createLogReadAdapter,
  cursorText,
  logCoverageHeaders,
  logDetailWindow,
  readLogProtectedDetail,
} from '../log-read-adapter';
import {
  LogQueryIncompleteError,
  LogQueryInvalidRequestError,
  logQueryErrorResponse,
} from '../log-archive-query';

const env = {} as Env;
const rows = [
  {
    id: 'c',
    tenant_id: 't',
    event_type: 'auth.failed',
    event_category: 'auth',
    result: 'failure',
    created_at: 3000,
    details_json: '{"ip_address":"192.0.2.1","grant_type":"code"}',
  },
  {
    id: 'b',
    tenant_id: 't',
    event_type: 'auth.success',
    event_category: 'auth',
    result: 'success',
    created_at: 3000,
    details_json: '{"ipAddress":"192.0.2.1","grantType":"code"}',
  },
  {
    id: 'a',
    tenant_id: 't',
    event_type: 'token.issued',
    event_category: 'token',
    result: 'success',
    created_at: 2000,
    details_json: null,
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    rows,
    hasArchive: true,
    consistency: 'snapshot',
    pendingDeliveries: 0,
  });
  mocks.detail.mockResolvedValue({ reason_detail: 'authorized reason' });
});
describe('Iceberg read adapter integration', () => {
  it('uses only the new backend and local SQL, even when an original database is supplied', async () => {
    const db = { query: vi.fn(), queryOne: vi.fn(), getType: () => 'postgres' };
    const read = createLogReadAdapter({
      env,
      tenantId: 't',
      dataset: 'core.event_log',
      adapter: db as never,
    });
    expect(
      await read.adapter.query(
        'SELECT result,COUNT(*) AS n FROM event_log WHERE tenant_id=? GROUP BY result ORDER BY result',
        ['t']
      )
    ).toEqual([
      { result: 'failure', n: 1 },
      { result: 'success', n: 2 },
    ]);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(read.adapter.getType()).toBe('sqlite');
    expect(read.coverage()).toEqual({
      consistency: 'snapshot',
      pending_deliveries: 0,
      complete: true,
    });
  });
  it('pushes conjunctive timestamps and event identity to Core, and always reads cold details', async () => {
    const read = createLogReadAdapter({
      env,
      tenantId: 't',
      dataset: 'core.event_log',
    });
    await read.adapter.queryOne(
      'SELECT id FROM event_log WHERE tenant_id=? AND id=? AND created_at>=? AND created_at<=?',
      ['t', 'b', 2000, 4000]
    );
    expect(mocks.read).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: 't',
        sourceDataset: 'core.event_log',
        eventId: 'b',
        fromMs: 2000,
        toMs: 4000,
      })
    );
    const app = new Hono();
    app.get('/', (c) => c.json(logDetailWindow(c)));
    expect(await (await app.request('/')).json()).toEqual({ window: {} });
  });
  it('does not push unsafe OR bounds and handles quoted question marks in fixed SQL', async () => {
    const read = createLogReadAdapter({ env, tenantId: 't', dataset: 'core.event_log' });
    await read.adapter.query(
      "SELECT id,'?' AS question FROM event_log WHERE created_at>=? OR id=?",
      [3000, 'a']
    );
    expect(mocks.read.mock.calls[0][1]).not.toHaveProperty('fromMs');
  });
  it('keeps equal-time cursor ordering stable and binds cursors to scope', async () => {
    const first = createLogReadAdapter({
      env,
      tenantId: 't',
      dataset: 'core.event_log',
      page: { limit: 1, scope: 'scope' },
    });
    const sql =
      'SELECT id,created_at FROM event_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?';
    expect(await first.adapter.query(sql, ['t', 1, 0])).toEqual([{ id: 'c', created_at: 3000 }]);
    expect(first.pagination()).toMatchObject({ has_more: true, limit: 1 });
    const second = createLogReadAdapter({
      env,
      tenantId: 't',
      dataset: 'core.event_log',
      page: { limit: 1, scope: 'scope', cursor: first.pagination()?.next_cursor ?? undefined },
    });
    expect(await second.adapter.query(sql, ['t', 1, 0])).toEqual([{ id: 'b', created_at: 3000 }]);
    expect(() =>
      createLogReadAdapter({
        env,
        tenantId: 't',
        dataset: 'core.event_log',
        page: {
          limit: 1,
          scope: 'wrong',
          cursor: cursorText({ v: 1, scope: 'scope', at: 3000, id: 'c' }),
        },
      })
    ).toThrow(LogQueryInvalidRequestError);
  });
  it('uses seconds cursor units for account history, Check audit, and Operational logs', async () => {
    mocks.read.mockResolvedValue({
      rows: [
        { id: 'b', tenant_id: 't', created_at: 2 },
        { id: 'a', tenant_id: 't', created_at: 1 },
      ],
      hasArchive: true,
      consistency: 'snapshot',
      pendingDeliveries: 0,
    });
    const read = createLogReadAdapter({
      env,
      tenantId: 't',
      dataset: 'core.audit_log',
      page: { limit: 1, scope: 'account' },
    });
    expect(
      await read.adapter.query('SELECT id,created_at FROM audit_log WHERE tenant_id=? LIMIT ?', [
        't',
        1,
      ])
    ).toEqual([{ id: 'b', created_at: 2 }]);
    const cursor = read.pagination()?.next_cursor;
    expect(cursor).toBe(cursorText({ v: 1, scope: 'account', at: 2000, id: 'b' }));
  });
  it('projects private IP/agent metadata in Worker memory for existing security SQL', async () => {
    const read = createLogReadAdapter({ env, tenantId: 't', dataset: 'core.event_log' });
    expect(
      await read.adapter.queryOne(
        "SELECT COUNT(*) AS n FROM event_log WHERE tenant_id=? AND ip_address=? AND event_type LIKE 'auth.%'",
        ['t', '192.0.2.1']
      )
    ).toEqual({ n: 2 });
  });
  it('shares a request-local snapshot for count and list and supports future dataset schemas', async () => {
    const read = createLogReadAdapter({ env, tenantId: 't', dataset: 'core.event_log' });
    await read.adapter.queryOne('SELECT COUNT(*) AS n FROM event_log WHERE tenant_id=?', ['t']);
    await read.adapter.query('SELECT id FROM event_log WHERE tenant_id=? LIMIT ?', ['t', 2]);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    mocks.read.mockResolvedValue({
      rows: [],
      hasArchive: false,
      consistency: 'snapshot',
      pendingDeliveries: 0,
    });
    const other = createLogReadAdapter({
      env,
      tenantId: 't',
      dataset: 'core.mapping_events',
      columns: ['id', 'tenant_id', 'created_at', 'action'],
    });
    expect(await other.adapter.queryOne('SELECT COUNT(*) AS n FROM mapping_events')).toEqual({
      n: 0,
    });
  });
  it('never marks an empty Pipeline view as complete and exposes delay in headers', async () => {
    mocks.read.mockResolvedValue({
      rows: [],
      hasArchive: false,
      consistency: 'eventual',
      pendingDeliveries: 3,
    });
    const app = new Hono();
    app.get('/', async (c) => {
      const read = createLogReadAdapter({
        env,
        tenantId: 't',
        dataset: 'core.event_log',
        onCoverage: logCoverageHeaders(c),
      });
      const result = await read.adapter.queryOne('SELECT COUNT(*) AS n FROM event_log');
      return c.json({ result, coverage: read.coverage() });
    });
    const response = await app.request('/');
    expect(response.headers.get('X-Authrim-Log-Complete')).toBe('false');
    expect(response.headers.get('X-Authrim-Log-Pending-Deliveries')).toBe('3');
    expect(await response.json()).toMatchObject({
      result: { n: 0 },
      coverage: { consistency: 'eventual', complete: false },
    });
  });
  it('does not disclose tenant delivery volume to a self-service subject', async () => {
    mocks.read.mockResolvedValue({
      rows: [],
      hasArchive: false,
      consistency: 'eventual',
      pendingDeliveries: 999,
    });
    const app = new Hono();
    app.get('/', async (c) => {
      const read = createLogReadAdapter({
        env,
        tenantId: 't',
        dataset: 'core.audit_log',
        includePendingDeliveries: false,
        onCoverage: logCoverageHeaders(c),
      });
      await read.adapter.queryOne('SELECT COUNT(*) AS n FROM audit_log');
      return c.json({ coverage: read.coverage() });
    });
    const response = await app.request('/');
    expect(response.headers.has('X-Authrim-Log-Pending-Deliveries')).toBe(false);
    expect(await response.json()).toMatchObject({
      coverage: { pending_deliveries: null, complete: false },
    });
  });
  it('captures queued parameters and stops queued backend work after a failed query', async () => {
    const read = createLogReadAdapter({ env, tenantId: 't', dataset: 'core.event_log' });
    const values = ['c'];
    const pending = read.adapter.query('SELECT id FROM event_log WHERE id=?', values);
    values[0] = 'a';
    expect(await pending).toEqual([{ id: 'c' }]);
    mocks.read.mockRejectedValueOnce(new Error('catalog unavailable'));
    const failing = read.adapter.query('SELECT id FROM event_log WHERE created_at>=?', [1000]);
    const queued = read.adapter.query('SELECT id FROM event_log WHERE created_at>=?', [2000]);
    const results = await Promise.allSettled([failing, queued]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it('fails closed on Core errors, unsupported SQL, cross-tenant rows and protected plaintext', async () => {
    const read = () =>
      createLogReadAdapter({ env, tenantId: 't', dataset: 'core.event_log' }).adapter;
    mocks.read.mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(read().query('SELECT id FROM event_log')).rejects.toBeInstanceOf(
      LogQueryIncompleteError
    );
    await expect(read().query('SELECT * FROM object_catalog')).rejects.toBeInstanceOf(
      LogQueryIncompleteError
    );
    mocks.read.mockResolvedValue({
      rows: [{ id: 'x', tenant_id: 'other' }],
      hasArchive: false,
      consistency: 'snapshot',
      pendingDeliveries: 0,
    });
    await expect(read().query('SELECT id FROM event_log')).rejects.toBeInstanceOf(
      LogQueryIncompleteError
    );
    mocks.read.mockResolvedValue({
      rows: [{ id: 'x', tenant_id: 't', before_json: '{"secret":true}' }],
      hasArchive: true,
      consistency: 'snapshot',
      pendingDeliveries: 0,
    });
    await expect(
      createLogReadAdapter({ env, tenantId: 't', dataset: 'admin.admin_audit_log' }).adapter.query(
        'SELECT * FROM admin_audit_log'
      )
    ).rejects.toBeInstanceOf(LogQueryIncompleteError);
  });
  it('maps incomplete reads to explicit 503 and has no write/transaction fallback', async () => {
    const adapter = createLogReadAdapter({ env, tenantId: 't', dataset: 'core.event_log' }).adapter;
    await expect(adapter.execute('DELETE FROM event_log')).rejects.toBeInstanceOf(
      LogQueryIncompleteError
    );
    await expect(adapter.transaction(async () => 1)).rejects.toBeInstanceOf(
      LogQueryIncompleteError
    );
    const app = new Hono();
    app.get('/', (c) => logQueryErrorResponse(c, new LogQueryIncompleteError())!);
    expect((await app.request('/')).status).toBe(503);
  });
  it('loads protected detail only through the explicit separate API and sanitizes failures', async () => {
    const read = createLogReadAdapter({ env, tenantId: 't', dataset: 'core.event_log' });
    await read.adapter.query('SELECT id FROM event_log');
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(
      await readLogProtectedDetail(env, {
        tenantId: 't',
        sourceDataset: 'core.operational_logs',
        eventId: 'x',
      })
    ).toEqual({ reason_detail: 'authorized reason' });
    mocks.detail.mockRejectedValueOnce(new Error('secret-encryption-material'));
    await expect(
      readLogProtectedDetail(env, {
        tenantId: 't',
        sourceDataset: 'core.operational_logs',
        eventId: 'x',
      })
    ).rejects.toThrow('Log results are incomplete');
  });
});
