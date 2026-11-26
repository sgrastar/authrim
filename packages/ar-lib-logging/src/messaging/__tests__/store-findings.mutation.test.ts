import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAt, storeHarness } from './store-mutation-harness';

afterEach(() => {
  vi.useRealTimers();
});

const findingRow = {
  id: 'finding-1',
  message_job_id: 'job-1',
  finding_type: 'stuck_claim',
  severity: 'critical',
  status: 'open',
  safe_action: 'requeue',
  dangerous_action: 'drop',
  impact_json: '{"rows":2}',
  detected_at: 10,
  updated_at: 11,
  resolved_at: 12,
  applied_at: 13,
  applied_by: 'admin-1',
  tenant_key: 'tkey-1',
  job_kind: 'retry_delivery',
  job_status: 'claimed',
};

const findingRecord = {
  id: 'finding-1',
  messageJobId: 'job-1',
  findingType: 'stuck_claim',
  severity: 'critical',
  status: 'open',
  safeAction: 'requeue',
  dangerousAction: 'drop',
  impact: { rows: 2 },
  detectedAt: 10,
  updatedAt: 11,
  resolvedAt: 12,
  appliedAt: 13,
  appliedBy: 'admin-1',
  tenantKey: 'tkey-1',
  jobKind: 'retry_delivery',
  jobStatus: 'claimed',
};

describe('recordRepairFinding', () => {
  const base = {
    messageJobId: 'job-1',
    findingType: 'stuck_claim' as const,
    severity: 'error' as const,
  };

  it('writes an open finding with null optionals by default', async () => {
    const { store, execute } = storeHarness();
    const id = await store.recordRepairFinding({ ...base, id: 'finding-1', now: 500 });
    expect(id).toBe('finding-1');
    const { sql, params } = callAt(execute);
    expect(sql).toContain('INSERT INTO logging_message_repair_findings');
    expect(params).toEqual([
      'finding-1',
      'job-1',
      'stuck_claim',
      'error',
      'open',
      null,
      null,
      null,
      500,
      500,
      null,
    ]);
  });

  it('writes every given field, and an empty impact as null', async () => {
    const { store, execute } = storeHarness();
    await store.recordRepairFinding({
      ...base,
      id: 'finding-2',
      status: 'safe_repaired',
      safeAction: 'requeue',
      dangerousAction: 'drop',
      impact: { rows: 2 },
      now: 500,
    });
    await store.recordRepairFinding({ ...base, id: 'finding-3', impact: {}, now: 500 });
    expect(callAt(execute, 0).params).toEqual([
      'finding-2',
      'job-1',
      'stuck_claim',
      'error',
      'safe_repaired',
      'requeue',
      'drop',
      '{"rows":2}',
      500,
      500,
      null,
    ]);
    expect(callAt(execute, 1).params[7]).toBeNull();
  });

  it('names a finding at the given time, or now', async () => {
    const { store } = storeHarness();
    expect(await store.recordRepairFinding({ ...base, now: 0x0123456789ab })).toMatch(
      /^rw_01234567-89ab-7/
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0x0123456789ab));
    const { store: second, execute } = storeHarness();
    expect(await second.recordRepairFinding(base)).toMatch(/^rw_01234567-89ab-7/);
    expect(callAt(execute).params.slice(8, 10)).toEqual([0x0123456789ab, 0x0123456789ab]);
  });
});

describe('listRepairFindings', () => {
  it('has no WHERE clause without filters and maps the rows', async () => {
    const { store, query } = storeHarness();
    query.mockResolvedValueOnce([findingRow]);
    expect(await store.listRepairFindings()).toStrictEqual([findingRecord]);
    await store.listRepairFindings({});
    for (const index of [0, 1]) {
      const { sql, params } = callAt(query, index);
      expect(sql).not.toContain('WHERE');
      expect(sql.replace(/\s+/g, ' ')).toContain(
        'LEFT JOIN logging_message_jobs mj ON mj.id = f.message_job_id ORDER BY CASE'
      );
      expect(sql).toContain("WHEN 'critical' THEN 0");
      expect(sql).toContain('f.detected_at DESC');
      expect(params).toEqual([50, 0]);
    }
  });

  it('applies each filter alone', async () => {
    const cases: Array<[Record<string, unknown>, string, unknown[]]> = [
      [{ tenantKey: 'tk' }, 'mj.tenant_key = ?', ['tk']],
      [{ tenantKey: null }, 'mj.tenant_key IS NULL', []],
      [{ status: 'open' }, 'f.status = ?', ['open']],
      [{ severity: 'info' }, 'f.severity = ?', ['info']],
      [{ findingType: 'stuck_claim' }, 'f.finding_type = ?', ['stuck_claim']],
      [{ messageJobId: 'job-1' }, 'f.message_job_id = ?', ['job-1']],
    ];
    for (const [filter, clause, bound] of cases) {
      const { store, query } = storeHarness();
      await store.listRepairFindings(filter);
      const { sql, params } = callAt(query);
      expect(sql).toContain(`WHERE ${clause}\n`);
      expect(params).toEqual([...bound, 50, 0]);
    }
  });

  it('ignores an empty message job id and joins filters with AND', async () => {
    const { store, query } = storeHarness();
    await store.listRepairFindings({ messageJobId: '' });
    expect(callAt(query).sql).not.toContain('WHERE');
    await store.listRepairFindings({ status: 'open', severity: 'info' });
    expect(callAt(query, 1).sql).toContain('WHERE f.status = ? AND f.severity = ?\n');
  });
});

describe('getRepairFinding and markRepairFindingApplied', () => {
  it('reads a finding with its job by id', async () => {
    const { store, queryOne } = storeHarness();
    queryOne.mockResolvedValueOnce(findingRow);
    expect(await store.getRepairFinding('finding-1')).toStrictEqual(findingRecord);
    const { sql, params } = callAt(queryOne);
    expect(sql).toContain('WHERE f.id = ?');
    expect(sql).toContain('LEFT JOIN logging_message_jobs mj ON mj.id = f.message_job_id');
    expect(params).toEqual(['finding-1']);
    expect(await store.getRepairFinding('missing')).toBeNull();
  });

  it('reads an absent impact as null', async () => {
    const { store, queryOne } = storeHarness();
    queryOne.mockResolvedValueOnce({ ...findingRow, impact_json: null });
    expect(await store.getRepairFinding('finding-1')).toMatchObject({ impact: null });
  });

  it('resolves only an open finding', async () => {
    const { store, execute } = storeHarness();
    expect(
      await store.markRepairFindingApplied({
        id: 'finding-1',
        status: 'dangerous_applied',
        appliedBy: 'admin-1',
        now: 700,
      })
    ).toBe(true);
    const { sql, params } = callAt(execute);
    expect(sql).toContain(
      'SET status = ?, updated_at = ?, resolved_at = ?, applied_at = ?, applied_by = ?'
    );
    expect(params).toEqual(['dangerous_applied', 700, 700, 700, 'admin-1', 'finding-1', 'open']);
  });
});
