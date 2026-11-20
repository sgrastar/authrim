import { describe, expect, it } from 'vitest';
import { AgentBulkRepository } from '../core/repositories/agent-bulk-repository';
import {
  AUDIT_STATEMENT,
  auditWrite,
  batchStatements,
  fakeAdapter,
  fakeAuditWriter,
  flat,
} from './helpers/mut-repos-fakes';

function setup() {
  const db = fakeAdapter();
  const writer = fakeAuditWriter();
  return { ...db, writer, repo: new AgentBulkRepository(db.adapter, writer) };
}

const EXECUTION_GUARD = {
  from: 'agent_bulk_tenant_executions',
  where: 'id = ? AND last_transition_id = ?',
  params: ['exec-1', 'audit-1'],
};
const ok = { rowsAffected: 1, success: true };
const none = { rowsAffected: 0, success: true };

const fence = {
  controlTenantId: 'control',
  bulkPlanId: 'bulk-1',
  bulkPlanVersion: 1,
  executionId: 'exec-1',
  executionAttempt: 2,
  executionFence: 3,
  now: 10,
  audit: auditWrite(),
};

describe('AgentBulkRepository.advanceTenantStage', () => {
  it('returns the execution to pending at the next stage under the attempt/fence', async () => {
    const { repo, batch, writer, adapter } = setup();
    const run = () => repo.advanceTenantStage({ ...fence, from: 'validate', to: 'apply' });
    batch.mockResolvedValueOnce([ok]);
    await expect(run()).resolves.toBe(true);
    const [update, audit] = batchStatements(batch);
    const sql = flat(update.sql);
    expect(sql).toContain(
      "SET status = 'pending', stage = ?, precondition_snapshot_digest = COALESCE(?, precondition_snapshot_digest), result_json = COALESCE(?, result_json), result_digest = COALESCE(?, result_digest), execution_owner_id = NULL, execution_lease_expires_at = NULL, child_capability_digest = NULL, child_capability_expires_at = NULL"
    );
    expect(sql).toContain(
      "WHERE id = ? AND bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'running' AND stage = ? AND execution_attempt = ? AND execution_fence = ?"
    );
    expect(sql).toContain(
      "AND p.control_tenant_id = ? AND p.status = 'running' AND p.cancelled_at IS NULL)"
    );
    expect(update.params).toEqual([
      'apply',
      null,
      null,
      null,
      'audit-1',
      10,
      'exec-1',
      'bulk-1',
      1,
      'validate',
      2,
      3,
      'control',
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, fence.audit, EXECUTION_GUARD);
    batch.mockResolvedValueOnce([none]);
    await expect(run()).resolves.toBe(false);
    batch.mockResolvedValueOnce([]);
    await expect(run()).resolves.toBe(false);
  });

  it('binds the snapshot digest and checkpoint when provided', async () => {
    const { repo, batch } = setup();
    await repo.advanceTenantStage({
      ...fence,
      from: 'apply',
      to: 'verify',
      preconditionSnapshotDigest: 'snap-d',
      checkpoint: { applied: 2 },
      checkpointDigest: 'cp-d',
    });
    expect(batchStatements(batch)[0].params!.slice(0, 4)).toEqual([
      'verify',
      'snap-d',
      '{"applied":2}',
      'cp-d',
    ]);
  });
});

describe('AgentBulkRepository.completeTenant', () => {
  it.each([
    ['succeeded', 'succeeded_count'],
    ['failed', 'failed_count'],
    ['indeterminate', 'indeterminate_count'],
  ] as const)('records a %s execution and increments %s', async (status, counter) => {
    const { repo, batch, writer, adapter } = setup();
    batch.mockResolvedValueOnce([ok, ok]);
    await expect(repo.completeTenant({ ...fence, status })).resolves.toBe(true);
    const [execution, plan, audit] = batchStatements(batch);
    expect(flat(execution.sql)).toBe(
      "UPDATE agent_bulk_tenant_executions SET status = ?, result_json = ?, result_digest = ?, failure_kind = ?, completed_at = ?, updated_at = ?, last_transition_id = ? WHERE id = ? AND bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'running' AND execution_attempt = ? AND execution_fence = ?"
    );
    expect(execution.params).toEqual([
      status,
      null,
      null,
      null,
      10,
      10,
      'audit-1',
      'exec-1',
      'bulk-1',
      1,
      2,
      3,
    ]);
    expect(flat(plan.sql)).toBe(
      `UPDATE agent_bulk_plans SET ${counter} = ${counter} + 1, updated_at = ? WHERE control_tenant_id = ? AND id = ? AND version = ? AND status = 'running' AND EXISTS (SELECT 1 FROM agent_bulk_tenant_executions WHERE id = ? AND last_transition_id = ?)`
    );
    expect(plan.params).toEqual([10, 'control', 'bulk-1', 1, 'exec-1', 'audit-1']);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, fence.audit, EXECUTION_GUARD);
  });

  it('binds result details when provided', async () => {
    const { repo, batch } = setup();
    batch.mockResolvedValueOnce([ok, ok]);
    await repo.completeTenant({
      ...fence,
      status: 'failed',
      result: { error: 'x' },
      resultDigest: 'res-d',
      failureKind: 'conflict',
    });
    expect(batchStatements(batch)[0].params!.slice(0, 4)).toEqual([
      'failed',
      '{"error":"x"}',
      'res-d',
      'conflict',
    ]);
  });

  it.each([[[ok, none]], [[none, ok]], [[ok]], [[]]])(
    'requires both the execution and plan counter writes: %j',
    async (results) => {
      const { repo, batch } = setup();
      batch.mockResolvedValueOnce(results);
      await expect(repo.completeTenant({ ...fence, status: 'succeeded' })).resolves.toBe(false);
    }
  );
});

const planRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'bulk-1',
  version: 1,
  control_tenant_id: 'control',
  grant_id: 'grant-1',
  actor_sub: 'agent:sub',
  client_id: 'client-1',
  definition_json: null,
  definition_digest: 'plan-d',
  target_snapshot_json: null,
  target_snapshot_digest: 't',
  canary_tenant_ids_json: null,
  canary_digest: 'c',
  status: 'running',
  stage: 'apply',
  canary_size: 1,
  wave_size: 2,
  wave_failure_threshold_bps: 500,
  current_wave: 0,
  succeeded_count: 0,
  failed_count: 0,
  indeterminate_count: 0,
  pause_reason: null,
  expires_at: 1,
  payload_purge_at: 1,
  payload_purged_at: null,
  created_at: 1,
  updated_at: 1,
  grant_generation: 1,
  consent_version: 1,
  cancelled_at: null,
  ...overrides,
});

let sequence = 0;
const exec = (
  id: string,
  status: string,
  stage: string,
  wave: number | null,
  canary = wave === null
) => ({
  id,
  bulk_plan_id: 'bulk-1',
  bulk_plan_version: 1,
  target_tenant_id: `tenant-${id}`,
  target_sequence: sequence++,
  is_canary: canary ? 1 : 0,
  wave_number: wave,
  stage,
  status,
  plan_digest: 'plan-d',
  execution_attempt: 0,
  execution_fence: 0,
  idempotency_key: id,
  result_json: null,
  created_at: 1,
  updated_at: 1,
});

async function runnable(rows: unknown[], plan: Record<string, unknown> | null = planRow()) {
  const { repo, query, queryOne } = setup();
  queryOne.mockResolvedValueOnce(plan);
  query.mockResolvedValueOnce(rows);
  const result = await repo.listRunnableTenantExecutions({
    controlTenantId: 'control',
    bulkPlanId: 'bulk-1',
    bulkPlanVersion: 1,
  });
  return { ids: result.map((item) => item.id), query };
}

describe('AgentBulkRepository.listRunnableTenantExecutions', () => {
  it('returns nothing for missing, non-running or cancelled plans', async () => {
    const rows = [exec('a', 'pending', 'validate', null)];
    const missing = await runnable(rows, null);
    expect(missing.ids).toEqual([]);
    expect(missing.query).not.toHaveBeenCalled();
    expect((await runnable(rows, planRow({ status: 'paused' }))).ids).toEqual([]);
    expect((await runnable(rows, planRow({ cancelled_at: 5 }))).ids).toEqual([]);
  });

  it('limits validation batches to the larger of wave and canary size', async () => {
    const rows = [
      exec('a', 'pending', 'validate', null),
      exec('b', 'pending', 'validate', 1),
      exec('c', 'pending', 'validate', 1),
      exec('d', 'pending', 'validate', 2),
      exec('e', 'succeeded', 'validate', 2),
    ];
    expect((await runnable(rows, planRow({ wave_size: 2, canary_size: 3 }))).ids).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect((await runnable(rows, planRow({ wave_size: 3, canary_size: 1 }))).ids).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('waits while any validation is still running', async () => {
    const rows = [exec('a', 'running', 'validate', null), exec('b', 'pending', 'apply', 1)];
    expect((await runnable(rows)).ids).toEqual([]);
  });

  it('runs canary apply first, waits for running canaries, then verifies', async () => {
    const plan = planRow({ canary_size: 1 });
    expect(
      (
        await runnable(
          [
            exec('a', 'pending', 'apply', null),
            exec('b', 'pending', 'apply', null),
            exec('w', 'pending', 'apply', 1),
          ],
          plan
        )
      ).ids
    ).toEqual(['a']);
    expect(
      (
        await runnable(
          [exec('a', 'running', 'apply', null), exec('b', 'pending', 'verify', null)],
          plan
        )
      ).ids
    ).toEqual([]);
    expect(
      (
        await runnable(
          [
            exec('a', 'succeeded', 'verify', null),
            exec('b', 'pending', 'verify', null),
            exec('w', 'pending', 'apply', 1),
          ],
          plan
        )
      ).ids
    ).toEqual(['b']);
  });

  it('does not advance to waves while a canary failed', async () => {
    const rows = [exec('a', 'failed', 'verify', null), exec('w', 'pending', 'apply', 1)];
    expect((await runnable(rows)).ids).toEqual([]);
  });

  it('walks waves in numeric order, skipping finished waves', async () => {
    const rows = [
      exec('canary', 'succeeded', 'verify', null),
      exec('w10', 'pending', 'apply', 10),
      exec('w2a', 'succeeded', 'verify', 2),
      exec('w2b', 'failed', 'verify', 2),
      exec('w3a', 'pending', 'apply', 3),
      exec('w3b', 'pending', 'apply', 3),
      exec('w3c', 'pending', 'apply', 3),
      exec('orphan', 'pending', 'apply', null, false),
    ];
    expect((await runnable(rows, planRow({ wave_size: 2 }))).ids).toEqual(['w3a', 'w3b']);
  });

  it('holds a wave with indeterminate or running members', async () => {
    const indeterminate = [
      exec('canary', 'succeeded', 'verify', null),
      exec('w1a', 'indeterminate', 'apply', 1),
      exec('w1b', 'succeeded', 'verify', 1),
      exec('w2', 'pending', 'apply', 2),
    ];
    expect((await runnable(indeterminate)).ids).toEqual([]);
    const running = [
      exec('canary', 'succeeded', 'verify', null),
      exec('w1a', 'running', 'apply', 1),
      exec('w1b', 'pending', 'verify', 1),
    ];
    expect((await runnable(running)).ids).toEqual([]);
  });

  it('returns nothing once every wave finished', async () => {
    const rows = [
      exec('canary', 'succeeded', 'verify', null),
      exec('w1', 'succeeded', 'verify', 1),
      exec('w2', 'failed', 'verify', 2),
    ];
    expect((await runnable(rows)).ids).toEqual([]);
  });
});
