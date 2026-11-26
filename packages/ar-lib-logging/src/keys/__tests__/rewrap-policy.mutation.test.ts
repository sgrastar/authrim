import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SqlLoggingRewrapJobQueue,
  classifyLoggingRewrapPriority,
  shouldSkipLoggingRewrapForRetention,
} from '../rewrap-policy';

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyLoggingRewrapPriority', () => {
  const priority = (input: Parameters<typeof classifyLoggingRewrapPriority>[0]) =>
    classifyLoggingRewrapPriority(input);

  it('puts compromised keys first, whatever the log', () => {
    expect(priority({ logType: 'normal', plane: 'primary', compromised: true })).toStrictEqual({
      priority: 0,
      reason: 'compromised',
    });
    expect(
      priority({
        logType: 'audit',
        plane: 'sensitive_detail',
        compromised: true,
        critical: true,
        recentlyAccessed: true,
      }).priority
    ).toBe(0);
  });

  it('puts sensitive details next', () => {
    expect(priority({ logType: 'normal', plane: 'sensitive_detail' })).toStrictEqual({
      priority: 10,
      reason: 'sensitive_detail',
    });
    expect(priority({ logType: 'audit', plane: 'sensitive_detail', critical: true }).reason).toBe(
      'sensitive_detail'
    );
  });

  it('then critical, audit and archive logs', () => {
    const critical = { priority: 20, reason: 'critical_archive' };
    expect(priority({ logType: 'normal', plane: 'primary', critical: true })).toStrictEqual(
      critical
    );
    expect(priority({ logType: 'admin_audit', plane: 'primary' })).toStrictEqual(critical);
    expect(priority({ logType: 'audit', plane: 'primary' })).toStrictEqual(critical);
    expect(priority({ logType: 'normal', plane: 'archive' })).toStrictEqual(critical);
    expect(priority({ logType: 'normal', plane: 'archive', recentlyAccessed: true })).toStrictEqual(
      critical
    );
  });

  it('then recently read logs, and the rest last', () => {
    expect(priority({ logType: 'normal', plane: 'primary', recentlyAccessed: true })).toStrictEqual(
      { priority: 30, reason: 'recent_access' }
    );
    expect(priority({ logType: 'normal', plane: 'primary' })).toStrictEqual({
      priority: 40,
      reason: 'default_archive',
    });
    expect(
      priority({
        logType: 'security',
        plane: 'external_sink',
        critical: false,
        recentlyAccessed: false,
      })
    ).toStrictEqual({ priority: 40, reason: 'default_archive' });
  });
});

describe('shouldSkipLoggingRewrapForRetention', () => {
  it('skips what will expire within the threshold, inclusive, and never what has no expiry', () => {
    const skip = (expiresAt: number | null | undefined, now = 1000, skipThresholdMs = 500) =>
      shouldSkipLoggingRewrapForRetention({ now, expiresAt, skipThresholdMs });
    expect(skip(1501)).toBe(false);
    expect(skip(1500)).toBe(true);
    expect(skip(1499)).toBe(true);
    expect(skip(500)).toBe(true);
    expect(skip(undefined)).toBe(false);
    expect(skip(null)).toBe(false);
    expect(skip(0)).toBe(false);
    expect(skip(1, 1000, 0)).toBe(true);
    expect(skip(1000, 1000, 0)).toBe(true);
    expect(skip(1001, 1000, 0)).toBe(false);
  });
});

describe('SqlLoggingRewrapJobQueue', () => {
  function harness(row: Record<string, unknown> | null = null) {
    const queryOne = vi.fn(async (_sql: string, _params?: unknown[]) => row as never);
    const execute = vi.fn(async (_sql: string, _params?: unknown[]) => undefined);
    return { queue: new SqlLoggingRewrapJobQueue({ queryOne, execute }), queryOne, execute };
  }

  it('stores a queued job with its priority and metadata, and returns it', async () => {
    const { queue, execute } = harness();
    const job = await queue.enqueue({
      id: 'lrw_1',
      keyRegistryId: 'reg_1',
      fromVersion: 1,
      toVersion: 2,
      priority: 20,
      metadata: { a: 1 },
      now: 5000,
    });
    expect(job).toStrictEqual({
      id: 'lrw_1',
      keyRegistryId: 'reg_1',
      fromVersion: 1,
      toVersion: 2,
      priority: 20,
      status: 'queued',
      createdAt: 5000,
      startedAt: null,
      completedAt: null,
      metadata: { a: 1 },
    });
    const [sql, params] = execute.mock.calls[0] ?? [];
    expect(sql).toContain('INSERT INTO logging_rewrap_jobs');
    expect(params).toEqual(['lrw_1', 'reg_1', 1, 2, 20, 'queued', 5000, null, null, '{"a":1}']);
  });

  it('stores no metadata when there is none or it is empty, and names the job from the time', async () => {
    const { queue, execute } = harness();
    const bare = await queue.enqueue({
      keyRegistryId: 'r',
      fromVersion: 1,
      toVersion: 2,
      priority: 1,
      now: 0x0123456789ab,
    });
    expect(bare.id).toMatch(/^lrw_01234567-89ab-7/);
    expect(bare.metadata).toBeNull();
    expect(execute.mock.calls[0]?.[1]?.[9]).toBeNull();
    await queue.enqueue({
      id: 'x',
      keyRegistryId: 'r',
      fromVersion: 1,
      toVersion: 2,
      priority: 1,
      metadata: {},
      now: 1,
    });
    expect(execute.mock.calls[1]?.[1]?.[9]).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0x0123456789ab));
    const clocked = await queue.enqueue({
      keyRegistryId: 'r',
      fromVersion: 1,
      toVersion: 2,
      priority: 1,
    });
    expect(clocked.createdAt).toBe(0x0123456789ab);
    expect(clocked.id).toMatch(/^lrw_01234567-89ab-7/);
  });

  const row = {
    id: 'lrw_1',
    key_registry_id: 'reg_1',
    from_version: 1,
    to_version: 2,
    priority: 20,
    status: 'queued',
    created_at: 10,
    started_at: null,
    completed_at: null,
    metadata: '{"a":1}',
  };

  it('claims the most urgent, oldest queued job and marks it running', async () => {
    const { queue, queryOne, execute } = harness(row);
    const job = await queue.claimNext(9000);
    expect(job).toStrictEqual({
      id: 'lrw_1',
      keyRegistryId: 'reg_1',
      fromVersion: 1,
      toVersion: 2,
      priority: 20,
      status: 'running',
      createdAt: 10,
      startedAt: 9000,
      completedAt: null,
      metadata: { a: 1 },
    });
    const [selectSql, selectParams] = queryOne.mock.calls[0] ?? [];
    expect(selectSql).toContain('WHERE status = ?');
    expect(selectSql).toContain('ORDER BY priority ASC, created_at ASC');
    expect(selectSql).toContain('LIMIT 1');
    expect(selectParams).toEqual(['queued']);
    const [updateSql, updateParams] = execute.mock.calls[0] ?? [];
    expect(updateSql).toContain('SET status = ?, started_at = ?');
    expect(updateSql).toContain('WHERE id = ? AND status = ?');
    expect(updateParams).toEqual(['running', 9000, 'lrw_1', 'queued']);
  });

  it('claims nothing when nothing is queued, and reads the clock by default', async () => {
    const empty = harness(null);
    expect(await empty.queue.claimNext(1)).toBeNull();
    expect(empty.execute).not.toHaveBeenCalled();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(4242));
    const { queue } = harness(row);
    expect((await queue.claimNext())?.startedAt).toBe(4242);
  });

  it('reads metadata that is absent, not an object or not JSON as none', async () => {
    for (const metadata of [null, '', '[1]', '"x"', '5', 'null', 'not json']) {
      const { queue } = harness({ ...row, metadata });
      expect((await queue.claimNext(1))?.metadata).toBeNull();
    }
  });

  it('completes only a running job', async () => {
    const { queue, execute } = harness();
    await queue.complete({ id: 'lrw_1', status: 'succeeded', metadata: { ok: true }, now: 7000 });
    await queue.complete({ id: 'lrw_2', status: 'failed', now: 8000 });
    const [sql, params] = execute.mock.calls[0] ?? [];
    expect(sql).toContain('SET status = ?, completed_at = ?, metadata = ?');
    expect(sql).toContain('WHERE id = ? AND status = ?');
    expect(params).toEqual(['succeeded', 7000, '{"ok":true}', 'lrw_1', 'running']);
    expect(execute.mock.calls[1]?.[1]).toEqual(['failed', 8000, null, 'lrw_2', 'running']);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(4242));
    await queue.complete({ id: 'lrw_3', status: 'skipped' });
    expect(execute.mock.calls[2]?.[1]?.[1]).toBe(4242);
    await queue.complete({ id: 'lrw_4', status: 'skipped', metadata: {}, now: 1 });
    expect(execute.mock.calls[3]?.[1]?.[2]).toBeNull();
  });
});
