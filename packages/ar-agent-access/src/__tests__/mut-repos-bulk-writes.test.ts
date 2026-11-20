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

const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
const PLAN_GUARD = {
  from: 'agent_bulk_plans',
  where: 'control_tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
  params: ['control', 'bulk-1', 1, 'audit-1'],
};

async function expectBatchCas(
  batch: ReturnType<typeof fakeAdapter>['batch'],
  run: () => Promise<boolean>
) {
  batch.mockResolvedValueOnce([{ rowsAffected: 1, success: true }]);
  await expect(run()).resolves.toBe(true);
  batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
  await expect(run()).resolves.toBe(false);
  batch.mockResolvedValueOnce([]);
  await expect(run()).resolves.toBe(false);
}

async function expectExecuteCas(
  execute: ReturnType<typeof fakeAdapter>['execute'],
  run: () => Promise<boolean>
) {
  execute.mockResolvedValueOnce({ rowsAffected: 1, success: true });
  await expect(run()).resolves.toBe(true);
  execute.mockResolvedValueOnce({ rowsAffected: 0, success: true });
  await expect(run()).resolves.toBe(false);
  execute.mockResolvedValueOnce({ rowsAffected: 2, success: true });
  await expect(run()).resolves.toBe(false);
}

const resolved = {
  definition: {
    schemaVersion: 'authrim-agent-bulk-plan-v1',
    targetTenantIds: ['t-a', 't-b', 't-c', 't-d', 't-e'],
    canaryTenantIds: ['t-b'],
    plan: { schemaVersion: 'authrim-agent-plan-v1', goal: 'g', steps: [] },
  },
  targetSnapshotDigest: 'targets-d',
  canaryDigest: 'canary-d',
  digest: 'plan-d',
  rollout: { canarySize: 1, waveSize: 2, waveFailureThresholdBasisPoints: 500 },
} as const;

const createBase = {
  id: 'bulk-1',
  version: 1,
  controlTenantId: 'control',
  grantId: 'grant-1',
  actorSub: 'agent:sub',
  clientId: 'client-1',
  grantGeneration: 2,
  consentVersion: 3,
  resolved: resolved as never,
  expiresAt: 100,
  payloadPurgeAt: 200,
  now: 10,
  audit: auditWrite(),
};

describe('AgentBulkRepository.create', () => {
  it('inserts a draft plan and one pending execution per target with wave numbers', async () => {
    const { repo, batch, writer } = setup();
    await repo.create(createBase);
    const statements = batchStatements(batch);
    expect(statements).toHaveLength(7);
    const plan = statements[0];
    expect(flat(plan.sql)).toContain('INSERT INTO agent_bulk_plans');
    expect(flat(plan.sql)).toContain("?, 'draft', 'validate', ?, ?, ?, ?, ?, ?, ?, ?)");
    expect(plan.params).toEqual([
      'bulk-1',
      1,
      'control',
      'grant-1',
      'agent:sub',
      'client-1',
      null,
      null,
      null,
      null,
      null,
      null,
      2,
      3,
      JSON.stringify(resolved.definition),
      'plan-d',
      '["t-a","t-b","t-c","t-d","t-e"]',
      'targets-d',
      '["t-b"]',
      'canary-d',
      1,
      2,
      500,
      'audit-1',
      100,
      200,
      10,
      10,
    ]);
    const executions = statements.slice(1, 6);
    for (const execution of executions) {
      expect(flat(execution.sql)).toContain('INSERT INTO agent_bulk_tenant_executions');
      expect(flat(execution.sql)).toContain(
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'validate', 'pending', ?, ?, ?, ?)"
      );
    }
    expect(executions.map((e) => e.params)).toEqual([
      ['abte_bulk-1_1_0', 'bulk-1', 1, 't-a', 0, 0, 1, 'plan-d', 'bulk-1:1:t-a', 10, 10],
      ['abte_bulk-1_1_1', 'bulk-1', 1, 't-b', 1, 1, null, 'plan-d', 'bulk-1:1:t-b', 10, 10],
      ['abte_bulk-1_1_2', 'bulk-1', 1, 't-c', 2, 0, 1, 'plan-d', 'bulk-1:1:t-c', 10, 10],
      ['abte_bulk-1_1_3', 'bulk-1', 1, 't-d', 3, 0, 2, 'plan-d', 'bulk-1:1:t-d', 10, 10],
      ['abte_bulk-1_1_4', 'bulk-1', 1, 't-e', 4, 0, 2, 'plan-d', 'bulk-1:1:t-e', 10, 10],
    ]);
    expect(statements[6]).toBe(AUDIT_STATEMENT);
    expect(writer.mock.calls[0][2]).toBeUndefined();
  });

  it('binds optional actor attributes when present', async () => {
    const { repo, batch } = setup();
    await repo.create({
      ...createBase,
      delegatorId: 'admin-1',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      machinePrincipalId: 'mp-1',
      machineCredentialId: 'mc-1',
    } as never);
    expect(batchStatements(batch)[0].params!.slice(6, 12)).toEqual([
      'admin-1',
      'mode_b',
      'machine_key',
      'dpop',
      'mp-1',
      'mc-1',
    ]);
  });
});

describe('AgentBulkRepository reads', () => {
  it('get, list and listRunning use tenant-scoped or running-only SQL', async () => {
    const { repo, query, queryOne } = setup();
    await expect(repo.get('control', 'bulk-1', 1)).resolves.toBeNull();
    expect(queryOne.mock.calls[0]).toEqual([
      'SELECT * FROM agent_bulk_plans WHERE control_tenant_id = ? AND id = ? AND version = ?',
      ['control', 'bulk-1', 1],
    ]);
    await expect(repo.list('control')).resolves.toEqual([]);
    expect(query.mock.calls[0]).toEqual([
      'SELECT * FROM agent_bulk_plans WHERE control_tenant_id = ? ORDER BY created_at DESC, id',
      ['control'],
    ]);
    await repo.listRunning();
    expect(flat(query.mock.calls[1][0])).toBe(
      "SELECT * FROM agent_bulk_plans WHERE status = 'running' AND cancelled_at IS NULL ORDER BY updated_at, control_tenant_id, id LIMIT ?"
    );
    expect(query.mock.calls[1][1]).toEqual([25]);
    await repo.listRunning(3);
    expect(query.mock.calls[2][1]).toEqual([3]);
  });

  it('tenant execution reads join through the control tenant', async () => {
    const { repo, query, queryOne } = setup();
    await repo.listTenantExecutions('control', 'bulk-1', 1);
    expect(flat(query.mock.calls[0][0])).toContain(
      'WHERE p.control_tenant_id = ? AND e.bulk_plan_id = ? AND e.bulk_plan_version = ? ORDER BY e.target_sequence'
    );
    expect(query.mock.calls[0][1]).toEqual(['control', 'bulk-1', 1]);
    await expect(repo.getTenantExecution('control', 'bulk-1', 1, 'exec-1')).resolves.toBeNull();
    expect(flat(queryOne.mock.calls[0][0])).toContain(
      'WHERE p.control_tenant_id = ? AND e.bulk_plan_id = ? AND e.bulk_plan_version = ? AND e.id = ?'
    );
    expect(queryOne.mock.calls[0][1]).toEqual(['control', 'bulk-1', 1, 'exec-1']);
  });
});

describe('AgentBulkRepository plan transitions', () => {
  it('startApproved binds all approval digests under CAS', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.startApproved({
        controlTenantId: 'control',
        id: 'bulk-1',
        version: 1,
        definitionDigest: 'plan-d',
        targetSnapshotDigest: 'targets-d',
        canaryDigest: 'canary-d',
        approvedBy: 'admin-1',
        approvalDigest: 'appr-d',
        now: 10,
        audit,
      });
    await expectBatchCas(batch, run);
    const [update, auditStatement] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_bulk_plans SET status = 'running', stage = 'validate', approved_by = ?, approved_at = ?, approval_digest = ?, last_transition_id = ?, updated_at = ? WHERE control_tenant_id = ? AND id = ? AND version = ? AND status = 'ready' AND definition_digest = ? AND target_snapshot_digest = ? AND canary_digest = ? AND expires_at > ? AND cancelled_at IS NULL"
    );
    expect(update.params).toEqual([
      'admin-1',
      10,
      'appr-d',
      'audit-1',
      10,
      'control',
      'bulk-1',
      1,
      'plan-d',
      'targets-d',
      'canary-d',
      10,
    ]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);
  });

  it('transition moves between statuses and shortens retention on completion', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const base = {
      controlTenantId: 'control',
      id: 'bulk-1',
      version: 1,
      from: 'running' as const,
      to: 'paused' as const,
      stage: 'apply' as const,
      now: 10,
      audit,
    };
    await expectBatchCas(batch, () => repo.transition(base));
    const [update] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_bulk_plans SET status = ?, stage = ?, pause_reason = ?, last_transition_id = ?, updated_at = ?, payload_purge_at = CASE WHEN ? = 'completed' THEN MIN(payload_purge_at, ?) ELSE payload_purge_at END WHERE control_tenant_id = ? AND id = ? AND version = ? AND status = ? AND cancelled_at IS NULL"
    );
    expect(update.params).toEqual([
      'paused',
      'apply',
      null,
      'audit-1',
      10,
      'paused',
      10 + THIRTY_DAYS,
      'control',
      'bulk-1',
      1,
      'running',
    ]);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);
    await repo.transition({ ...base, pauseReason: 'threshold' });
    expect(batchStatements(batch, 3)[0].params![2]).toBe('threshold');
  });

  it('cancel marks the plan and in-flight executions indeterminate', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.cancel({
        controlTenantId: 'control',
        id: 'bulk-1',
        version: 1,
        cancelledBy: 'admin-1',
        reason: 'stop',
        now: 10,
        audit,
      });
    await expectBatchCas(batch, run);
    const [plan, executions, auditStatement] = batchStatements(batch);
    const planSql = flat(plan.sql);
    expect(planSql).toContain(
      "indeterminate_count = indeterminate_count + ( SELECT COUNT(*) FROM agent_bulk_tenant_executions e WHERE e.bulk_plan_id = agent_bulk_plans.id AND e.bulk_plan_version = agent_bulk_plans.version AND e.status = 'running' )"
    );
    expect(planSql).toContain(
      "AND status IN ('draft', 'ready', 'running', 'paused') AND cancelled_at IS NULL"
    );
    expect(plan.params).toEqual([
      10,
      'admin-1',
      'stop',
      'audit-1',
      10,
      10 + THIRTY_DAYS,
      'control',
      'bulk-1',
      1,
    ]);
    expect(flat(executions.sql)).toBe(
      "UPDATE agent_bulk_tenant_executions SET status = 'indeterminate', failure_kind = 'plan_cancelled', completed_at = ?, updated_at = ?, execution_owner_id = NULL, execution_lease_expires_at = NULL, child_capability_digest = NULL, child_capability_expires_at = NULL WHERE bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'running' AND EXISTS (SELECT 1 FROM agent_bulk_plans p WHERE p.id = agent_bulk_tenant_executions.bulk_plan_id AND p.version = agent_bulk_tenant_executions.bulk_plan_version AND p.control_tenant_id = ? AND p.cancelled_at = ?)"
    );
    expect(executions.params).toEqual([10, 10, 'bulk-1', 1, 'control', 10]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);
  });

  it('setRunningProgress updates only running, uncancelled plans', async () => {
    const { repo, execute } = setup();
    const run = () =>
      repo.setRunningProgress({
        controlTenantId: 'control',
        id: 'bulk-1',
        version: 1,
        stage: 'apply',
        currentWave: 2,
        now: 10,
      });
    await expectExecuteCas(execute, run);
    const [sql, params] = execute.mock.calls[0];
    expect(flat(sql)).toBe(
      "UPDATE agent_bulk_plans SET stage = ?, current_wave = ?, updated_at = ? WHERE control_tenant_id = ? AND id = ? AND version = ? AND status = 'running' AND cancelled_at IS NULL"
    );
    expect(params).toEqual(['apply', 2, 10, 'control', 'bulk-1', 1]);
  });

  it.each([
    [undefined, 100],
    [7, 7],
  ])('purgePayloads binds limit %s as %s', async (limit, bound) => {
    const { repo, execute } = setup();
    execute.mockResolvedValueOnce({ rowsAffected: 3, success: true });
    await expect(repo.purgePayloads(10, limit)).resolves.toBe(3);
    const [sql, params] = execute.mock.calls[0];
    expect(flat(sql)).toBe(
      'UPDATE agent_bulk_plans SET definition_json = NULL, target_snapshot_json = NULL, canary_tenant_ids_json = NULL, payload_purged_at = ?, updated_at = ? WHERE rowid IN (SELECT rowid FROM agent_bulk_plans WHERE payload_purged_at IS NULL AND payload_purge_at <= ? LIMIT ?)'
    );
    expect(params).toEqual([10, 10, 10, bound]);
  });
});

describe('AgentBulkRepository tenant execution fencing', () => {
  it('claimTenant leases a pending execution of a running plan', async () => {
    const { repo, execute } = setup();
    const run = () =>
      repo.claimTenant({
        controlTenantId: 'control',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 1,
        executionId: 'exec-1',
        expectedStage: 'apply',
        ownerId: 'owner-1',
        leaseExpiresAt: 99,
        childCapabilityDigest: 'cap-d',
        childCapabilityExpiresAt: 88,
        now: 10,
      });
    await expectExecuteCas(execute, run);
    const [sql, params] = execute.mock.calls[0];
    const text = flat(sql);
    expect(text).toContain(
      "SET status = 'running', execution_attempt = execution_attempt + 1, execution_fence = execution_fence + 1"
    );
    expect(text).toContain('started_at = COALESCE(started_at, ?), updated_at = ?');
    expect(text).toContain(
      "WHERE id = ? AND bulk_plan_id = ? AND bulk_plan_version = ? AND status = 'pending' AND stage = ? AND EXISTS"
    );
    expect(text).toContain(
      "AND p.control_tenant_id = ? AND p.status = 'running' AND p.cancelled_at IS NULL )"
    );
    expect(params).toEqual([
      'owner-1',
      99,
      'cap-d',
      88,
      10,
      10,
      'exec-1',
      'bulk-1',
      1,
      'apply',
      'control',
    ]);
  });
});
