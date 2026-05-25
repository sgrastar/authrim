import { describe, expect, it } from 'vitest';
import { SqlLoggingMessageJobStore, type LoggingMessageSqlExecutor } from '../store';

interface JobRow {
  id: string;
  kind: string;
  status: string;
  lane: string;
  criticality: string;
  priority: number;
  tenant_id: string | null;
  tenant_key: string | null;
  topology_type: string;
  database_binding_ref: string | null;
  connection_ref: string | null;
  topology_snapshot_version: string | null;
  topology_resolved_at: number | null;
  scope_type: string;
  scope_id: string | null;
  scope_key: string;
  source_type: string;
  source_id: string;
  root_job_id: string | null;
  parent_job_id: string | null;
  depth: number;
  payload_object_ref: string;
  payload_sha256: string;
  payload_type: string;
  payload_schema_version: number;
  redacted_summary_json: string | null;
  validation_summary_json: string | null;
  idempotency_key: string | null;
  dedupe_until: number | null;
  not_before: number;
  attempt_count: number;
  max_attempts: number;
  attempt_policy_json: string | null;
  claim_token: string | null;
  claimed_at: number | null;
  claimed_until: number | null;
  requested_by: string | null;
  reason: string | null;
  error_class: string | null;
  last_error: string | null;
  blocked_reason: string | null;
  cancel_requested_at: number | null;
  cancelled_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number | null;
}

interface IdempotencyRow {
  scope_key: string;
  idempotency_key: string;
  message_job_id: string;
  status: string;
  dedupe_until: number;
}

class InMemoryMessageExecutor implements LoggingMessageSqlExecutor {
  readonly jobs = new Map<string, JobRow>();
  readonly idempotency = new Map<string, IdempotencyRow>();
  readonly findings: unknown[][] = [];
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params });
    if (sql.includes('FROM logging_message_repair_findings')) {
      return this.findings
        .filter((finding) => (params.includes('open') ? finding[4] === 'open' : true))
        .map((finding) => {
          const job = this.jobs.get(String(finding[1]));
          return {
            id: finding[0],
            message_job_id: finding[1],
            finding_type: finding[2],
            severity: finding[3],
            status: finding[4],
            safe_action: finding[5],
            dangerous_action: finding[6],
            impact_json: finding[7],
            detected_at: finding[8],
            updated_at: finding[9],
            resolved_at: null,
            applied_at: null,
            applied_by: null,
            tenant_key: job?.tenant_key ?? null,
            job_kind: job?.kind ?? null,
            job_status: job?.status ?? null,
          };
        }) as T[];
    }
    if (sql.includes('FROM logging_message_jobs') && sql.includes('claimed_until IS NOT NULL')) {
      const now = Number(params[2] ?? 0);
      const rows = [...this.jobs.values()]
        .filter(
          (row) =>
            (row.status === 'claimed' || row.status === 'running') && row.claimed_until !== null
        )
        .filter((row) => Number(row.claimed_until) <= now)
        .sort((left, right) => Number(left.claimed_until) - Number(right.claimed_until))
        .slice(0, Number(params.at(-1) ?? 50));
      return rows as T[];
    }
    if (sql.includes('FROM logging_message_jobs') && sql.includes('expires_at IS NOT NULL')) {
      const now = Number(params[2] ?? 0);
      const rows = [...this.jobs.values()]
        .filter(
          (row) => (row.status === 'queued' || row.status === 'retrying') && row.expires_at !== null
        )
        .filter((row) => Number(row.expires_at) <= now)
        .sort((left, right) => Number(left.expires_at) - Number(right.expires_at))
        .slice(0, Number(params.at(-1) ?? 50));
      return rows as T[];
    }
    if (sql.includes('FROM logging_message_jobs')) {
      const now = Number(params[2] ?? 0);
      const rows = [...this.jobs.values()]
        .filter(
          (row) => (row.status === 'queued' || row.status === 'retrying') && row.not_before <= now
        )
        .filter((row) => row.expires_at === null || row.expires_at > now)
        .sort((left, right) => right.priority - left.priority || left.not_before - right.not_before)
        .slice(0, Number(params.at(-1) ?? 50));
      return rows as T[];
    }
    return [];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    if (sql.includes('FROM logging_message_repair_findings')) {
      const finding = this.findings.find((item) => item[0] === params[0]);
      if (!finding) {
        return null;
      }
      const job = this.jobs.get(String(finding[1]));
      return {
        id: finding[0],
        message_job_id: finding[1],
        finding_type: finding[2],
        severity: finding[3],
        status: finding[4],
        safe_action: finding[5],
        dangerous_action: finding[6],
        impact_json: finding[7],
        detected_at: finding[8],
        updated_at: finding[9],
        resolved_at: null,
        applied_at: null,
        applied_by: null,
        tenant_key: job?.tenant_key ?? null,
        job_kind: job?.kind ?? null,
        job_status: job?.status ?? null,
      } as T;
    }
    if (sql.includes('FROM logging_message_jobs')) {
      return (this.jobs.get(String(params[0])) ?? null) as T | null;
    }
    if (sql.includes('FROM logging_message_idempotency_keys')) {
      const key = `${params[0]}\u001f${params[1]}`;
      return (this.idempotency.get(key) ?? null) as T | null;
    }
    return null;
  }

  async execute(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rowsAffected: number; success: true }> {
    if (sql.includes('INSERT INTO logging_message_jobs')) {
      const row: JobRow = {
        id: String(params[0]),
        kind: String(params[1]),
        status: String(params[2]),
        lane: String(params[3]),
        criticality: String(params[4]),
        priority: Number(params[5]),
        tenant_id: params[6] as string | null,
        tenant_key: params[7] as string | null,
        topology_type: String(params[8]),
        database_binding_ref: params[9] as string | null,
        connection_ref: params[10] as string | null,
        topology_snapshot_version: params[11] as string | null,
        topology_resolved_at: params[12] as number | null,
        scope_type: String(params[13]),
        scope_id: params[14] as string | null,
        scope_key: String(params[15]),
        source_type: String(params[16]),
        source_id: String(params[17]),
        root_job_id: params[18] as string | null,
        parent_job_id: params[19] as string | null,
        depth: Number(params[20]),
        payload_object_ref: String(params[21]),
        payload_sha256: String(params[22]),
        payload_type: String(params[23]),
        payload_schema_version: Number(params[24]),
        redacted_summary_json: params[25] as string | null,
        validation_summary_json: params[26] as string | null,
        idempotency_key: params[27] as string | null,
        dedupe_until: params[28] as number | null,
        not_before: Number(params[29]),
        attempt_count: Number(params[30]),
        max_attempts: Number(params[31]),
        attempt_policy_json: params[32] as string | null,
        claim_token: params[33] as string | null,
        claimed_at: params[34] as number | null,
        claimed_until: params[35] as number | null,
        requested_by: params[36] as string | null,
        reason: params[37] as string | null,
        error_class: params[38] as string | null,
        last_error: params[39] as string | null,
        blocked_reason: params[40] as string | null,
        cancel_requested_at: params[41] as number | null,
        cancelled_by: params[42] as string | null,
        created_at: Number(params[43]),
        updated_at: Number(params[44]),
        started_at: params[45] as number | null,
        completed_at: params[46] as number | null,
        expires_at: params[47] as number | null,
      };
      this.jobs.set(row.id, row);
      return { rowsAffected: 1, success: true };
    }
    if (sql.includes('INSERT INTO logging_message_idempotency_keys')) {
      const row: IdempotencyRow = {
        scope_key: String(params[0]),
        idempotency_key: String(params[1]),
        message_job_id: String(params[2]),
        status: String(params[7]),
        dedupe_until: Number(params[8]),
      };
      this.idempotency.set(`${row.scope_key}\u001f${row.idempotency_key}`, row);
      return { rowsAffected: 1, success: true };
    }
    if (
      sql.includes('UPDATE logging_message_jobs') &&
      sql.includes('claim_token = ?') &&
      sql.includes('claimed_at = ?')
    ) {
      const row = this.jobs.get(String(params[6]));
      if (!row || (row.status !== 'queued' && row.status !== 'retrying')) {
        return { rowsAffected: 0, success: true };
      }
      row.status = String(params[0]);
      row.claim_token = String(params[1]);
      row.claimed_at = Number(params[2]);
      row.claimed_until = Number(params[3]);
      row.attempt_count += 1;
      row.started_at ??= Number(params[4]);
      row.updated_at = Number(params[5]);
      return { rowsAffected: 1, success: true };
    }
    if (sql.includes('UPDATE logging_message_repair_findings')) {
      const finding = this.findings.find((item) => item[0] === params[5]);
      if (!finding || finding[4] !== params[6]) {
        return { rowsAffected: 0, success: true };
      }
      finding[4] = params[0];
      finding[9] = params[1];
      return { rowsAffected: 1, success: true };
    }
    if (sql.includes('SET status = ?, updated_at = ?')) {
      const row = this.jobs.get(String(params[2]));
      if (!row || row.claim_token !== params[3] || row.status !== 'claimed') {
        return { rowsAffected: 0, success: true };
      }
      row.status = String(params[0]);
      row.updated_at = Number(params[1]);
      return { rowsAffected: 1, success: true };
    }
    if (sql.includes('completed_at = ?') && sql.includes('WHERE id = ? AND claim_token = ?')) {
      const row = this.jobs.get(String(params[3]));
      if (!row || row.claim_token !== params[4]) {
        return { rowsAffected: 0, success: true };
      }
      row.status = String(params[0]);
      row.completed_at = Number(params[1]);
      row.updated_at = Number(params[2]);
      row.claim_token = null;
      row.claimed_at = null;
      row.claimed_until = null;
      return { rowsAffected: 1, success: true };
    }
    if (sql.includes('INSERT INTO logging_message_repair_findings')) {
      this.findings.push(params);
      return { rowsAffected: 1, success: true };
    }
    if (sql.includes('SET status = ?, last_error = ?, completed_at = ?')) {
      const row = this.jobs.get(String(params[4]));
      if (!row || !['queued', 'retrying', 'claimed', 'running'].includes(row.status)) {
        return { rowsAffected: 0, success: true };
      }
      row.status = String(params[0]);
      row.last_error = params[1] as string | null;
      row.completed_at = Number(params[2]);
      row.updated_at = Number(params[3]);
      row.claim_token = null;
      row.claimed_at = null;
      row.claimed_until = null;
      return { rowsAffected: 1, success: true };
    }
    if (sql.includes('WHERE id = ? AND status IN (?, ?) AND claimed_until IS NOT NULL')) {
      const row = this.jobs.get(String(params[5]));
      if (
        !row ||
        !['claimed', 'running'].includes(row.status) ||
        row.claimed_until === null ||
        row.claimed_until > Number(params[8])
      ) {
        return { rowsAffected: 0, success: true };
      }
      row.status = String(params[0]);
      if (row.status === 'retrying') {
        row.not_before = Number(params[1]);
        row.error_class = params[2] as string | null;
        row.last_error = params[3] as string | null;
        row.updated_at = Number(params[4]);
      } else {
        row.error_class = params[1] as string | null;
        row.last_error = params[2] as string | null;
        row.completed_at = Number(params[3]);
        row.updated_at = Number(params[4]);
      }
      row.claim_token = null;
      row.claimed_at = null;
      row.claimed_until = null;
      return { rowsAffected: 1, success: true };
    }
    return { rowsAffected: 0, success: true };
  }
}

function baseInput(now = 1000) {
  return {
    id: 'lmj_job',
    kind: 'retry_delivery' as const,
    lane: 'default' as const,
    criticality: 'standard' as const,
    topology: {
      tenantId: 'tenant_1',
      tenantKey: 't_1',
      topologyType: 'shared_d1' as const,
      topologyResolvedAt: now,
    },
    scopeType: 'tenant' as const,
    scopeId: 'tenant_1',
    scopeKey: 'tenant:t_1',
    sourceType: 'dlq_item' as const,
    sourceId: 'dlq_1',
    payloadObjectRef: 'message-jobs/retry_delivery/job.json',
    payloadSha256: 'hash',
    payloadType: 'retry_delivery',
    payloadSchemaVersion: 1,
    idempotencyKey: 'retry:dlq_1',
    dedupeUntil: now + 1000,
    notBefore: now,
    requestedBy: 'admin_1',
    reason: 'manual retry',
    now,
  };
}

describe('SqlLoggingMessageJobStore', () => {
  it('creates jobs with topology and idempotency metadata', async () => {
    const executor = new InMemoryMessageExecutor();
    const store = new SqlLoggingMessageJobStore(executor);

    const first = await store.createJob(baseInput());
    const duplicate = await store.createJob({ ...baseInput(), id: 'lmj_duplicate' });

    expect(first.id).toBe('lmj_job');
    expect(duplicate.id).toBe('lmj_job');
    expect(executor.jobs).toHaveLength(1);
    expect(first.topologyType).toBe('shared_d1');
    expect(first.redactedSummary).toBeNull();
  });

  it('claims due jobs and transitions claimed work to running and completed', async () => {
    const executor = new InMemoryMessageExecutor();
    const store = new SqlLoggingMessageJobStore(executor);
    await store.createJob({ ...baseInput(), id: 'lmj_claim', priority: 10 });

    const claimed = await store.claimDueJob({
      now: 1000,
      leaseMs: 30_000,
      claimToken: 'claim_1',
    });
    expect(claimed?.id).toBe('lmj_claim');
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.attemptCount).toBe(1);

    await expect(store.markRunning('lmj_claim', 'claim_1', 1001)).resolves.toBe(true);
    await expect(store.markCompleted('lmj_claim', 'claim_1', 1002)).resolves.toBe(true);
    await expect(store.getJob('lmj_claim')).resolves.toMatchObject({
      status: 'completed',
      completedAt: 1002,
      claimToken: null,
    });
  });

  it('enforces parent chain depth guard', async () => {
    const store = new SqlLoggingMessageJobStore(new InMemoryMessageExecutor(), { maxDepth: 2 });

    await expect(store.createJob({ ...baseInput(), depth: 3 })).rejects.toThrow(
      'logging_message_job_depth_exceeded'
    );
  });

  it('records repair findings for blocked or inconsistent jobs', async () => {
    const executor = new InMemoryMessageExecutor();
    const store = new SqlLoggingMessageJobStore(executor);

    const id = await store.recordRepairFinding({
      messageJobId: 'lmj_missing',
      findingType: 'missing_payload_object',
      severity: 'critical',
      safeAction: 'mark_blocked',
      impact: { payload_object_ref: 'missing' },
      now: 2000,
    });

    expect(id).toMatch(/^rw_/);
    expect(executor.findings).toHaveLength(1);

    await expect(store.listRepairFindings({ status: 'open' })).resolves.toMatchObject([
      {
        id,
        messageJobId: 'lmj_missing',
        findingType: 'missing_payload_object',
        severity: 'critical',
        status: 'open',
        safeAction: 'mark_blocked',
        impact: { payload_object_ref: 'missing' },
      },
    ]);
    await expect(store.getRepairFinding(id)).resolves.toMatchObject({
      id,
      findingType: 'missing_payload_object',
      status: 'open',
    });
    await expect(
      store.markRepairFindingApplied({
        id,
        status: 'safe_repaired',
        appliedBy: 'admin_1',
        now: 3000,
      })
    ).resolves.toBe(true);
  });

  it('detects expired and stuck jobs for safe repair transitions', async () => {
    const executor = new InMemoryMessageExecutor();
    const store = new SqlLoggingMessageJobStore(executor);
    await store.createJob({ ...baseInput(), id: 'lmj_expired', expiresAt: 1500 });
    await store.createJob({ ...baseInput(), id: 'lmj_stuck', idempotencyKey: 'retry:stuck' });

    const stuckRow = executor.jobs.get('lmj_stuck');
    expect(stuckRow).toBeDefined();
    stuckRow!.status = 'running';
    stuckRow!.claim_token = 'claim_stuck';
    stuckRow!.claimed_at = 1100;
    stuckRow!.claimed_until = 1200;
    stuckRow!.attempt_count = 1;

    await expect(store.listExpiredQueuedJobs({ now: 2000 })).resolves.toMatchObject([
      { id: 'lmj_expired', status: 'queued' },
    ]);
    await expect(store.markExpired({ id: 'lmj_expired', now: 2000 })).resolves.toBe(true);
    await expect(
      store.repairStuckLeaseForRetry({
        id: 'lmj_stuck',
        now: 2000,
        notBefore: 2300,
        errorClass: 'lease_timeout',
        lastError: 'Claim lease expired before completion.',
      })
    ).resolves.toBe(true);

    await expect(store.getJob('lmj_expired')).resolves.toMatchObject({ status: 'expired' });
    await expect(store.getJob('lmj_stuck')).resolves.toMatchObject({
      status: 'retrying',
      notBefore: 2300,
      claimToken: null,
    });
  });

  it('caps list limits and offsets before querying storage', async () => {
    const executor = new InMemoryMessageExecutor();
    const store = new SqlLoggingMessageJobStore(executor);

    await expect(store.listJobs({ limit: 999_999, offset: 999_999 })).resolves.toEqual([]);

    const query = executor.queries.at(-1);
    expect(query?.params.at(-2)).toBe(500);
    expect(query?.params.at(-1)).toBe(100_000);
  });
});
