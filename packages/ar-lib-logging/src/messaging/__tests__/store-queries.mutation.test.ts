import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAt, fullJobRecord, fullJobRow, storeHarness } from './store-mutation-harness';

afterEach(() => {
  vi.useRealTimers();
});

describe('list limits and offsets', () => {
  async function limitOf(limit: number | undefined): Promise<unknown> {
    const { store, query } = storeHarness();
    await store.listDueJobs({ now: 1, limit });
    return callAt(query).params.at(-1);
  }

  async function offsetOf(offset: number | undefined): Promise<unknown> {
    const { store, query } = storeHarness();
    await store.listJobs({ offset });
    return callAt(query).params.at(-1);
  }

  it('defaults, floors and clamps the limit to 1..500', async () => {
    expect(await limitOf(undefined)).toBe(50);
    expect(await limitOf(Number.NaN)).toBe(50);
    expect(await limitOf(Number.POSITIVE_INFINITY)).toBe(50);
    expect(await limitOf(0)).toBe(1);
    expect(await limitOf(-5)).toBe(1);
    expect(await limitOf(1)).toBe(1);
    expect(await limitOf(7.9)).toBe(7);
    expect(await limitOf(500)).toBe(500);
    expect(await limitOf(1000)).toBe(500);
  });

  it('defaults, floors and clamps the offset to 0..100000', async () => {
    expect(await offsetOf(undefined)).toBe(0);
    expect(await offsetOf(Number.NaN)).toBe(0);
    expect(await offsetOf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(await offsetOf(-3)).toBe(0);
    expect(await offsetOf(2.9)).toBe(2);
    expect(await offsetOf(100_000)).toBe(100_000);
    expect(await offsetOf(200_000)).toBe(100_000);
  });
});

describe('listDueJobs', () => {
  it('asks only for due work when no lane or kind is given', async () => {
    const { store, query } = storeHarness();
    query.mockResolvedValueOnce([fullJobRow()]);
    const jobs = await store.listDueJobs({ now: 1200 });
    expect(jobs).toStrictEqual([fullJobRecord]);
    const { sql, params } = callAt(query);
    expect(sql).toContain(
      'WHERE (status = ? OR status = ?) AND not_before <= ? AND (expires_at IS NULL OR expires_at > ?)\n'
    );
    expect(sql).toContain('ORDER BY priority DESC, not_before ASC, created_at ASC');
    expect(params).toEqual(['queued', 'retrying', 1200, 1200, 50]);
  });

  it('adds the lane and the kind independently', async () => {
    const { store, query } = storeHarness();
    await store.listDueJobs({ now: 1, lane: 'default' });
    await store.listDueJobs({ now: 1, kind: 'export_build' });
    expect(callAt(query, 0).sql).toContain('AND lane = ?\n');
    expect(callAt(query, 0).sql).not.toContain('kind = ?');
    expect(callAt(query, 0).params).toEqual(['queued', 'retrying', 1, 1, 'default', 50]);
    expect(callAt(query, 1).sql).toContain('AND kind = ?\n');
    expect(callAt(query, 1).sql).not.toContain('lane = ?');
    expect(callAt(query, 1).params).toEqual(['queued', 'retrying', 1, 1, 'export_build', 50]);
  });
});

describe('listJobs', () => {
  it('has no WHERE clause without filters', async () => {
    const { store, query } = storeHarness();
    query.mockResolvedValueOnce([fullJobRow()]);
    expect(await store.listJobs()).toStrictEqual([fullJobRecord]);
    await store.listJobs({});
    for (const index of [0, 1]) {
      const { sql, params } = callAt(query, index);
      expect(sql).not.toContain('WHERE');
      expect(sql.replace(/\s+/g, ' ')).toBe(
        'SELECT * FROM logging_message_jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
      );
      expect(sql).toContain('LIMIT ? OFFSET ?');
      expect(params).toEqual([50, 0]);
    }
  });

  it('applies each filter alone', async () => {
    const cases: Array<[Record<string, unknown>, string, unknown[]]> = [
      [{ tenantKey: 'tk' }, 'tenant_key = ?', ['tk']],
      [{ tenantKey: '' }, 'tenant_key = ?', ['']],
      [{ tenantKey: null }, 'tenant_key IS NULL', []],
      [{ scopeKey: 'sk' }, 'scope_key = ?', ['sk']],
      [{ kind: 'export_build' }, 'kind = ?', ['export_build']],
      [{ status: 'dlq' }, 'status = ?', ['dlq']],
      [{ lane: 'default' }, 'lane = ?', ['default']],
      [{ sourceType: 'dlq_item' }, 'source_type = ?', ['dlq_item']],
      [{ sourceId: 'sid' }, 'source_id = ?', ['sid']],
      [{ rootJobId: 'rid' }, 'root_job_id = ?', ['rid']],
      [{ parentJobId: 'pid' }, 'parent_job_id = ?', ['pid']],
      [{ parentJobId: null }, 'parent_job_id IS NULL', []],
      [{ createdAfter: 0 }, 'created_at >= ?', [0]],
      [{ createdBefore: 0 }, 'created_at <= ?', [0]],
    ];
    for (const [filter, clause, bound] of cases) {
      const { store, query } = storeHarness();
      await store.listJobs(filter);
      const { sql, params } = callAt(query);
      expect(sql).toContain(`WHERE ${clause}\n`);
      expect(params).toEqual([...bound, 50, 0]);
    }
  });

  it('ignores empty text filters and non-numeric times', async () => {
    const { store, query } = storeHarness();
    await store.listJobs({
      scopeKey: '',
      sourceId: '',
      rootJobId: '',
      createdAfter: undefined,
      createdBefore: undefined,
    });
    expect(callAt(query).sql).not.toContain('WHERE');
    expect(callAt(query).params).toEqual([50, 0]);
  });

  it('joins several filters with AND', async () => {
    const { store, query } = storeHarness();
    await store.listJobs({ kind: 'export_build', status: 'dlq', limit: 5, offset: 6 });
    expect(callAt(query).sql).toContain('WHERE kind = ? AND status = ?\n');
    expect(callAt(query).params).toEqual(['export_build', 'dlq', 5, 6]);
  });
});

describe('repair lists', () => {
  it('lists claims whose lease has run out', async () => {
    const { store, query } = storeHarness();
    query.mockResolvedValueOnce([fullJobRow()]);
    expect(await store.listStuckClaimJobs({ now: 900 })).toStrictEqual([fullJobRecord]);
    const { sql, params } = callAt(query);
    expect(sql).toContain(
      'WHERE (status = ? OR status = ?) AND claimed_until IS NOT NULL AND claimed_until <= ?\n'
    );
    expect(sql).toContain('ORDER BY claimed_until ASC, priority DESC, created_at ASC');
    expect(params).toEqual(['claimed', 'running', 900, 50]);
  });

  it('lists queued work past its expiry', async () => {
    const { store, query } = storeHarness();
    query.mockResolvedValueOnce([fullJobRow()]);
    expect(await store.listExpiredQueuedJobs({ now: 900 })).toStrictEqual([fullJobRecord]);
    const { sql, params } = callAt(query);
    expect(sql).toContain(
      'WHERE (status = ? OR status = ?) AND expires_at IS NOT NULL AND expires_at <= ?\n'
    );
    expect(sql).toContain('ORDER BY expires_at ASC, priority DESC, created_at ASC');
    expect(params).toEqual(['queued', 'retrying', 900, 50]);
  });

  it('narrows both lists by lane and kind and bounds them', async () => {
    const { store, query } = storeHarness();
    for (const list of [
      store.listStuckClaimJobs.bind(store),
      store.listExpiredQueuedJobs.bind(store),
    ]) {
      await list({ now: 5, lane: 'default', kind: 'retry_delivery', limit: 4 });
      await list({ now: 5, lane: 'default' });
      await list({ now: 5, kind: 'export_build' });
    }
    const calls = [0, 1, 2, 3, 4, 5].map((index) => callAt(query, index));
    const tails = calls.map((call) =>
      call.sql.split('WHERE ')[1]?.split('\n')[0]?.split(' AND ').slice(3)
    );
    expect(tails).toEqual([
      ['lane = ?', 'kind = ?'],
      ['lane = ?'],
      ['kind = ?'],
      ['lane = ?', 'kind = ?'],
      ['lane = ?'],
      ['kind = ?'],
    ]);
    expect(calls[0]?.params.slice(3)).toEqual(['default', 'retry_delivery', 4]);
    expect(calls[1]?.params.slice(3)).toEqual(['default', 50]);
    expect(calls[2]?.params.slice(3)).toEqual(['export_build', 50]);
  });
});

describe('claimDueJob', () => {
  const claim = { now: 1000, leaseMs: 500, claimToken: 'claim-1', limit: 3 };

  it('claims the first due job with the lease and returns it', async () => {
    const { store, query, queryOne, execute } = storeHarness();
    query.mockResolvedValueOnce([{ id: 'job-1' }]);
    queryOne.mockResolvedValueOnce(fullJobRow({ status: 'claimed' }));

    const claimed = await store.claimDueJob({ ...claim, lane: 'default' });

    expect(claimed).toMatchObject({ id: 'job-1', claimToken: 'claim-1' });
    expect(callAt(query).params).toEqual(['queued', 'retrying', 1000, 1000, 'default', 3]);
    const { sql, params } = callAt(execute);
    expect(sql).toContain('attempt_count = attempt_count + 1');
    expect(sql).toContain('WHERE id = ?\n           AND (status = ? OR status = ?)');
    expect(params).toEqual([
      'claimed',
      'claim-1',
      1000,
      1500,
      1000,
      1000,
      'job-1',
      'queued',
      'retrying',
      1000,
      1000,
    ]);
  });

  it('returns nothing when no job is due', async () => {
    const { store, execute } = storeHarness();
    expect(await store.claimDueJob(claim)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not return a job that another worker holds under a different claim token', async () => {
    const { store, query, queryOne } = storeHarness();
    query.mockResolvedValueOnce([{ id: 'job-1' }]);
    queryOne.mockResolvedValueOnce(fullJobRow({ status: 'claimed', claim_token: 'other-claim' }));
    expect(await store.claimDueJob(claim)).toBeNull();
    expect(queryOne).toHaveBeenCalledOnce();
  });

  it('skips a job whose update touched no row, but reads one with an unknown count', async () => {
    for (const rowsAffected of [undefined, null, {}, { rowsAffected: 'many' }]) {
      const { store, query, queryOne } = storeHarness({ rowsAffected });
      query.mockResolvedValueOnce([{ id: 'job-1' }]);
      queryOne.mockResolvedValueOnce(fullJobRow({ status: 'claimed' }));
      expect(await store.claimDueJob(claim)).toMatchObject({
        id: 'job-1',
        status: 'claimed',
        claimToken: 'claim-1',
      });
      expect(queryOne).toHaveBeenCalledOnce();
    }
    const lost = storeHarness({ rowsAffected: { rowsAffected: 0 } });
    lost.query.mockResolvedValueOnce([{ id: 'job-1' }]);
    expect(await lost.store.claimDueJob(claim)).toBeNull();
    expect(lost.queryOne).not.toHaveBeenCalled();
  });
});

describe('guarded status updates', () => {
  const lease = 'NULL, claimed_at = NULL';

  it('answers from the number of rows the update touched', async () => {
    const outcomes: Array<[unknown, boolean]> = [
      [{ rowsAffected: 1 }, true],
      [{ rowsAffected: 3 }, true],
      [{ rowsAffected: 0 }, false],
      [{ rowsAffected: -1 }, false],
      [{ rowsAffected: 'x' }, false],
      [{}, false],
      [undefined, false],
      [null, false],
    ];
    for (const [rowsAffected, expected] of outcomes) {
      const { store } = storeHarness({ rowsAffected });
      expect(await store.markRunning('j', 'c', 1)).toBe(expected);
      expect(await store.markCompleted('j', 'c', 1)).toBe(expected);
      expect(await store.markRetrying({ id: 'j', claimToken: 'c', now: 1, notBefore: 2 })).toBe(
        expected
      );
      expect(await store.markFailed({ id: 'j', claimToken: 'c', now: 1 })).toBe(expected);
      expect(await store.markBlocked({ id: 'j', now: 1, blockedReason: 'r' })).toBe(expected);
      expect(await store.markExpired({ id: 'j', now: 1 })).toBe(expected);
      expect(await store.repairStuckLeaseForRetry({ id: 'j', now: 1, notBefore: 2 })).toBe(
        expected
      );
      expect(await store.repairStuckLeaseToDlq({ id: 'j', now: 1 })).toBe(expected);
      expect(await store.requestCancel('j', 'a', 1)).toBe(expected);
      expect(await store.markCancelled('j', 1)).toBe(expected);
      expect(
        await store.markRepairFindingApplied({ id: 'f', status: 'ignored', appliedBy: 'a', now: 1 })
      ).toBe(expected);
    }
  });

  it('marks a claimed job running', async () => {
    const { store, execute } = storeHarness();
    await store.markRunning('job-1', 'claim-1', 1100);
    const { sql, params } = callAt(execute);
    expect(sql).toContain('SET status = ?, updated_at = ?');
    expect(sql).toContain('WHERE id = ? AND claim_token = ? AND status = ?');
    expect(params).toEqual(['running', 1100, 'job-1', 'claim-1', 'claimed']);
  });

  it('completes a job of the claim and releases the lease', async () => {
    const { store, execute } = storeHarness();
    await store.markCompleted('job-1', 'claim-1', 1100);
    const { sql, params } = callAt(execute);
    expect(sql).toContain(lease);
    expect(sql).toContain('WHERE id = ? AND claim_token = ? AND (status = ? OR status = ?)');
    expect(params).toEqual(['completed', 1100, 1100, 'job-1', 'claim-1', 'claimed', 'running']);
  });

  it('retries with null error details by default', async () => {
    const { store, execute } = storeHarness();
    await store.markRetrying({ id: 'job-1', claimToken: 'claim-1', now: 1100, notBefore: 1300 });
    expect(callAt(execute).params).toEqual([
      'retrying',
      1300,
      null,
      null,
      1100,
      'job-1',
      'claim-1',
      'claimed',
      'running',
    ]);
  });

  it('fails a job as failed unless told otherwise', async () => {
    const { store, execute } = storeHarness();
    const request = { id: 'job-1', claimToken: 'claim-1', now: 1100 };
    await store.markFailed(request);
    await store.markFailed({ ...request, status: 'dlq', errorClass: 'ec', lastError: 'le' });
    const first = callAt(execute, 0);
    expect(first.sql).toContain(lease);
    expect(first.sql).toContain('WHERE id = ? AND claim_token = ? AND (status = ? OR status = ?)');
    expect(first.params).toEqual([
      'failed',
      null,
      null,
      1100,
      1100,
      'job-1',
      'claim-1',
      'claimed',
      'running',
    ]);
    expect(callAt(execute, 1).params).toEqual([
      'dlq',
      'ec',
      'le',
      1100,
      1100,
      'job-1',
      'claim-1',
      'claimed',
      'running',
    ]);
  });

  it('blocks a job with a reason', async () => {
    const { store, execute } = storeHarness();
    await store.markBlocked({ id: 'job-1', now: 1100, blockedReason: 'no config' });
    await store.markBlocked({
      id: 'job-1',
      now: 1100,
      blockedReason: 'no config',
      errorClass: 'ec',
      lastError: 'le',
    });
    expect(callAt(execute, 0).sql).toContain(lease);
    expect(callAt(execute, 0).sql).toContain('WHERE id = ?');
    expect(callAt(execute, 0).params).toEqual(['blocked', 'no config', null, null, 1100, 'job-1']);
    expect(callAt(execute, 1).params).toEqual(['blocked', 'no config', 'ec', 'le', 1100, 'job-1']);
  });

  it('expires a job that is still open', async () => {
    const { store, execute } = storeHarness();
    await store.markExpired({ id: 'job-1', now: 1100 });
    await store.markExpired({ id: 'job-1', now: 1100, lastError: 'le' });
    expect(callAt(execute, 0).sql).toContain('status IN (?, ?, ?, ?)');
    expect(callAt(execute, 0).params).toEqual([
      'expired',
      null,
      1100,
      1100,
      'job-1',
      'queued',
      'retrying',
      'claimed',
      'running',
    ]);
    expect(callAt(execute, 1).params[1]).toBe('le');
  });

  it('repairs a lapsed lease for a retry or into the dead-letter queue', async () => {
    const { store, execute } = storeHarness();
    await store.repairStuckLeaseForRetry({ id: 'job-1', now: 1100, notBefore: 1300 });
    await store.repairStuckLeaseForRetry({
      id: 'job-1',
      now: 1100,
      notBefore: 1300,
      errorClass: 'ec',
      lastError: 'le',
    });
    await store.repairStuckLeaseToDlq({ id: 'job-1', now: 1100 });
    await store.repairStuckLeaseToDlq({
      id: 'job-1',
      now: 1100,
      errorClass: 'ec',
      lastError: 'le',
    });
    for (const index of [0, 2]) {
      expect(callAt(execute, index).sql).toContain(
        'WHERE id = ? AND status IN (?, ?) AND claimed_until IS NOT NULL AND claimed_until <= ?'
      );
    }
    expect(callAt(execute, 0).params).toEqual([
      'retrying',
      1300,
      null,
      null,
      1100,
      'job-1',
      'claimed',
      'running',
      1100,
    ]);
    expect(callAt(execute, 1).params).toEqual([
      'retrying',
      1300,
      'ec',
      'le',
      1100,
      'job-1',
      'claimed',
      'running',
      1100,
    ]);
    expect(callAt(execute, 2).params).toEqual([
      'dlq',
      null,
      null,
      1100,
      1100,
      'job-1',
      'claimed',
      'running',
      1100,
    ]);
    expect(callAt(execute, 3).params).toEqual([
      'dlq',
      'ec',
      'le',
      1100,
      1100,
      'job-1',
      'claimed',
      'running',
      1100,
    ]);
  });

  it('records a cancel request and cancels anything but completed work', async () => {
    const { store, execute } = storeHarness();
    await store.requestCancel('job-1', 'admin-1', 1100);
    await store.markCancelled('job-1', 1200);
    expect(callAt(execute, 0).params).toEqual([
      1100,
      'admin-1',
      1100,
      'job-1',
      'queued',
      'retrying',
      'claimed',
      'running',
    ]);
    expect(callAt(execute, 1).sql).toContain('WHERE id = ? AND status <> ?');
    expect(callAt(execute, 1).params).toEqual(['cancelled', 1200, 1200, 'job-1', 'completed']);
  });
});
