import { describe, expect, it, vi } from 'vitest';
import { SqlLoggingMessageJobStore, type LoggingMessageSqlExecutor } from '../store';

function harness() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []);
  const queryOne = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => null);
  const execute = vi.fn(
    async (_sql: string, _params?: unknown[]): Promise<{ rowsAffected: number }> => ({
      rowsAffected: 1,
    })
  );
  const executor = { query, queryOne, execute } as unknown as LoggingMessageSqlExecutor;
  return { store: new SqlLoggingMessageJobStore(executor), query, queryOne, execute };
}

function input() {
  return {
    id: 'job-a',
    kind: 'retry_delivery' as const,
    lane: 'default' as const,
    criticality: 'critical' as const,
    topology: {
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      topologyType: 'control_plane_d1' as const,
    },
    scopeType: 'tenant' as const,
    scopeId: 'tenant-a',
    scopeKey: 'tenant:tenant-key-a',
    sourceType: 'dlq_item' as const,
    sourceId: 'dlq-a',
    payloadObjectRef: 'message-jobs/job-a.json',
    payloadSha256: 'a'.repeat(64),
    payloadType: 'retry_delivery',
    payloadSchemaVersion: 1,
    idempotencyKey: 'retry:dlq-a',
    dedupeUntil: 2000,
    now: 1000,
  };
}

describe('message job query boundaries', () => {
  it('binds every requested tenant, source, chain, status, and time filter', async () => {
    const { store, query } = harness();

    await store.listJobs({
      tenantKey: 'tenant-key-a',
      scopeKey: 'tenant:tenant-key-a',
      kind: 'retry_delivery',
      status: 'retrying',
      lane: 'default',
      sourceType: 'dlq_item',
      sourceId: 'dlq-a',
      rootJobId: 'root-a',
      parentJobId: 'parent-a',
      createdAfter: 100,
      createdBefore: 200,
      limit: 3,
      offset: 4,
    });

    const [sql, params] = query.mock.calls[0];
    for (const predicate of [
      'tenant_key = ?',
      'scope_key = ?',
      'kind = ?',
      'status = ?',
      'lane = ?',
      'source_type = ?',
      'source_id = ?',
      'root_job_id = ?',
      'parent_job_id = ?',
      'created_at >= ?',
      'created_at <= ?',
    ]) {
      expect(sql).toContain(predicate);
    }
    expect(params).toEqual([
      'tenant-key-a',
      'tenant:tenant-key-a',
      'retry_delivery',
      'retrying',
      'default',
      'dlq_item',
      'dlq-a',
      'root-a',
      'parent-a',
      100,
      200,
      3,
      4,
    ]);
  });

  it('uses IS NULL for platform rows and root jobs instead of binding a nullable tenant', async () => {
    const { store, query } = harness();

    await store.listJobs({ tenantKey: null, parentJobId: null });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('tenant_key IS NULL');
    expect(sql).toContain('parent_job_id IS NULL');
    expect(params).toEqual([50, 0]);
  });

  it('limits due work to the requested lane and kind at the same clock instant', async () => {
    const { store, query } = harness();

    await store.listDueJobs({ now: 1200, lane: 'default', kind: 'retry_delivery', limit: 9 });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('(status = ? OR status = ?)');
    expect(sql).toContain('not_before <= ?');
    expect(sql).toContain('(expires_at IS NULL OR expires_at > ?)');
    expect(sql).toContain('lane = ?');
    expect(sql).toContain('kind = ?');
    expect(params).toEqual(['queued', 'retrying', 1200, 1200, 'default', 'retry_delivery', 9]);
  });

  it('filters repair findings by the joined job tenant and finding identity', async () => {
    const { store, query } = harness();

    await store.listRepairFindings({
      tenantKey: 'tenant-key-a',
      status: 'open',
      severity: 'critical',
      findingType: 'missing_payload_object',
      messageJobId: 'job-a',
      limit: 7,
      offset: 2,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN logging_message_jobs mj ON mj.id = f.message_job_id');
    expect(sql).toContain('mj.tenant_key = ?');
    expect(sql).toContain('f.message_job_id = ?');
    expect(params).toEqual([
      'tenant-key-a',
      'open',
      'critical',
      'missing_payload_object',
      'job-a',
      7,
      2,
    ]);
  });
});

describe('message job guarded mutations', () => {
  it('updates a stale idempotency reservation before inserting the new job', async () => {
    const { store, queryOne, execute } = harness();
    queryOne.mockResolvedValue({ message_job_id: 'old-job', dedupe_until: 900, status: 'active' });

    const result = await store.createJob(input());

    expect(result.id).toBe('job-a');
    expect(execute).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = execute.mock.calls[0];
    expect(updateSql).toContain('UPDATE logging_message_idempotency_keys');
    expect(updateSql).toContain('WHERE scope_key = ? AND idempotency_key = ?');
    expect(updateParams).toEqual([
      'job-a',
      'retry_delivery',
      'a'.repeat(64),
      'default',
      'critical',
      'active',
      2000,
      1000,
      1000,
      'tenant:tenant-key-a',
      'retry:dlq-a',
    ]);
    expect(execute.mock.calls[1][0]).toContain('INSERT INTO logging_message_jobs');
  });

  it('does not claim a job that another worker won, then tries the next due job', async () => {
    const { store, query, queryOne, execute } = harness();
    query.mockResolvedValue([{ id: 'lost-job' }, { id: 'next-job' }]);
    execute.mockResolvedValueOnce({ rowsAffected: 0 }).mockResolvedValueOnce({ rowsAffected: 1 });
    queryOne.mockResolvedValue({ id: 'next-job', claim_token: 'claim-a' });

    const claimed = await store.claimDueJob({ now: 1000, leaseMs: 5000, claimToken: 'claim-a' });

    expect(claimed).toMatchObject({ id: 'next-job', claimToken: 'claim-a' });
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [sql, params] of execute.mock.calls) {
      expect(sql).toContain('claim_token = ?');
      expect(sql).toContain('not_before <= ?');
      expect(sql).toContain('(claimed_until IS NULL OR claimed_until <= ?)');
      expect(params.slice(0, 4)).toEqual(['claimed', 'claim-a', 1000, 6000]);
    }
    expect(execute.mock.calls.map((call) => call[1][6])).toEqual(['lost-job', 'next-job']);
    expect(queryOne).toHaveBeenCalledOnce();
  });

  it('does not accept a claim result with a different token', async () => {
    const { store, query, queryOne, execute } = harness();
    query.mockResolvedValue([{ id: 'job-a' }]);
    queryOne.mockResolvedValue({ id: 'job-a', claim_token: 'claim-other' });

    await expect(
      store.claimDueJob({ now: 1000, leaseMs: 5000, claimToken: 'claim-a' })
    ).resolves.toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retries only a job owned by the supplied claim and clears claim metadata', async () => {
    const { store, execute } = harness();
    execute.mockResolvedValueOnce({ rowsAffected: 0 }).mockResolvedValueOnce({ rowsAffected: 1 });
    const request = {
      id: 'job-a',
      claimToken: 'claim-a',
      now: 1100,
      notBefore: 1300,
      errorClass: 'remote_timeout',
      lastError: 'redacted timeout',
    };

    await expect(store.markRetrying(request)).resolves.toBe(false);
    await expect(store.markRetrying(request)).resolves.toBe(true);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('claim_token = NULL, claimed_at = NULL, claimed_until = NULL');
    expect(sql).toContain('WHERE id = ? AND claim_token = ? AND (status = ? OR status = ?)');
    expect(params).toEqual([
      'retrying',
      1300,
      'remote_timeout',
      'redacted timeout',
      1100,
      'job-a',
      'claim-a',
      'claimed',
      'running',
    ]);
  });

  it('guards cancellation and repair against completed or already resolved work', async () => {
    const { store, execute } = harness();
    execute.mockResolvedValue({ rowsAffected: 0 });

    await expect(store.requestCancel('job-a', 'admin-a', 1200)).resolves.toBe(false);
    await expect(store.markCancelled('job-a', 1201)).resolves.toBe(false);
    await expect(
      store.markRepairFindingApplied({
        id: 'finding-a',
        status: 'safe_repaired',
        appliedBy: 'admin-a',
        now: 1202,
      })
    ).resolves.toBe(false);
    expect(execute.mock.calls[0][0]).toContain('status IN (?, ?, ?, ?)');
    expect(execute.mock.calls[1][0]).toContain('status <> ?');
    expect(execute.mock.calls[2][0]).toContain('WHERE id = ? AND status = ?');
    expect(execute.mock.calls[2][1]).toEqual([
      'safe_repaired',
      1202,
      1202,
      1202,
      'admin-a',
      'finding-a',
      'open',
    ]);
  });
});
