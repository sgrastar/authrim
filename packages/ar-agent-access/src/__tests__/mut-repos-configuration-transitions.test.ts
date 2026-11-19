import { describe, expect, it } from 'vitest';
import { AgentConfigurationRepository } from '../core/repositories/agent-configuration-repository';
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
  return { ...db, writer, repo: new AgentConfigurationRepository(db.adapter, writer) };
}

const PLAN_GUARD = {
  from: 'agent_configuration_plans',
  where: 'tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ?',
  params: ['tenant-1', 'plan-1', 2, 'audit-1'],
};
const THIRTY_DAYS = 30 * 24 * 60 * 60_000;

async function expectCasBoolean(
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

describe('AgentConfigurationRepository plan transitions', () => {
  it('markPlanReady moves an unexpired, uncancelled draft to ready/apply', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.markPlanReady({
        tenantId: 'tenant-1',
        id: 'plan-1',
        version: 2,
        definitionDigest: 'pd-1',
        snapshot: { s: 1 },
        diff: { d: 1 },
        validation: { v: 1 },
        now: 10,
        audit,
      });
    await expectCasBoolean(batch, run);
    const [update, auditStatement] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_configuration_plans SET status = 'ready', stage = 'apply', snapshot_json = ?, diff_json = ?, validation_json = ?, last_transition_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'draft' AND definition_digest = ? AND expires_at > ? AND cancelled_at IS NULL"
    );
    expect(update.params).toEqual([
      '{"s":1}',
      '{"d":1}',
      '{"v":1}',
      'audit-1',
      10,
      'tenant-1',
      'plan-1',
      2,
      'pd-1',
      10,
    ]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);
  });

  it('claimPlanApply without confirmation binds NULL and skips the consume statement', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.claimPlanApply({
        tenantId: 'tenant-1',
        id: 'plan-1',
        version: 2,
        definitionDigest: 'pd-1',
        now: 10,
        audit,
      });
    await expectCasBoolean(batch, run);
    const statements = batchStatements(batch);
    expect(statements).toHaveLength(2);
    const sql = flat(statements[0].sql);
    expect(sql).toContain("SET status = 'running', last_transition_id = ?, updated_at = ?");
    expect(sql).toContain(
      "WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'ready' AND stage = 'apply' AND definition_digest = ? AND expires_at > ? AND cancelled_at IS NULL"
    );
    expect(sql).toContain('AND (? IS NULL OR EXISTS ( SELECT 1 FROM agent_plan_confirmations c');
    expect(sql).toContain("AND c.status = 'confirmed' AND c.expires_at > ?");
    expect(sql).toContain('AND c.actor_sub = agent_configuration_plans.actor_sub');
    expect(statements[0].params).toEqual([
      'audit-1',
      10,
      'tenant-1',
      'plan-1',
      2,
      'pd-1',
      10,
      null,
      null,
      10,
    ]);
    expect(statements[1]).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);
  });

  it('claimPlanApply with a confirmation consumes it in the same batch', async () => {
    const { repo, batch } = setup();
    await repo.claimPlanApply({
      tenantId: 'tenant-1',
      id: 'plan-1',
      version: 2,
      definitionDigest: 'pd-1',
      now: 10,
      audit: auditWrite(),
      confirmationId: 'conf-1',
    });
    const statements = batchStatements(batch);
    expect(statements).toHaveLength(3);
    expect(statements[0].params!.slice(7, 9)).toEqual(['conf-1', 'conf-1']);
    const consume = statements[1];
    expect(flat(consume.sql)).toBe(
      "UPDATE agent_plan_confirmations SET status = 'consumed', consumed_at = ?, last_transition_id = ? WHERE id = ? AND tenant_id = ? AND plan_id = ? AND plan_version = ? AND plan_digest = ? AND grant_id = ( SELECT grant_id FROM agent_configuration_plans WHERE tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ? ) AND actor_sub = ( SELECT actor_sub FROM agent_configuration_plans WHERE tenant_id = ? AND id = ? AND version = ? AND last_transition_id = ? ) AND status = 'confirmed' AND expires_at > ?"
    );
    expect(consume.params).toEqual([
      10,
      'audit-1',
      'conf-1',
      'tenant-1',
      'plan-1',
      2,
      'pd-1',
      'tenant-1',
      'plan-1',
      2,
      'audit-1',
      'tenant-1',
      'plan-1',
      2,
      'audit-1',
      10,
    ]);
    expect(statements[2]).toBe(AUDIT_STATEMENT);
  });

  it('completePlan records the verify stage and shortens payload retention', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const base = {
      tenantId: 'tenant-1',
      id: 'plan-1',
      version: 2,
      definitionDigest: 'pd-1',
      result: { ok: true },
      appliedStepCount: 3,
      now: 10,
      audit,
    };
    await expectCasBoolean(batch, () => repo.completePlan({ ...base, status: 'completed' }));
    const [update] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_configuration_plans SET status = ?, stage = 'verify', result_json = ?, applied_step_count = ?, failed_step_id = ?, failure_kind = ?, last_transition_id = ?, updated_at = ?, payload_purge_at = MIN(payload_purge_at, ?) WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'running' AND definition_digest = ? AND cancelled_at IS NULL"
    );
    expect(update.params).toEqual([
      'completed',
      '{"ok":true}',
      3,
      null,
      null,
      'audit-1',
      10,
      10 + THIRTY_DAYS,
      'tenant-1',
      'plan-1',
      2,
      'pd-1',
    ]);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);

    await repo.completePlan({
      ...base,
      status: 'failed',
      failedStepId: 'step-2',
      failureKind: 'conflict',
    });
    expect(batchStatements(batch, 3)[0].params!.slice(0, 5)).toEqual([
      'failed',
      '{"ok":true}',
      3,
      'step-2',
      'conflict',
    ]);
  });

  it('cancelPlan cancels only open plans and shortens payload retention', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.cancelPlan({
        tenantId: 'tenant-1',
        id: 'plan-1',
        version: 2,
        cancelledBy: 'admin-1',
        reason: 'stop',
        now: 10,
        audit,
      });
    await expectCasBoolean(batch, run);
    const [update] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_configuration_plans SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, last_transition_id = ?, updated_at = ?, payload_purge_at = MIN(payload_purge_at, ?) WHERE tenant_id = ? AND id = ? AND version = ? AND status IN ('draft', 'ready', 'running') AND cancelled_at IS NULL"
    );
    expect(update.params).toEqual([
      10,
      'admin-1',
      'stop',
      'audit-1',
      10,
      10 + THIRTY_DAYS,
      'tenant-1',
      'plan-1',
      2,
    ]);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);
  });

  it('failCancelledRunningPlan fails a running plan that was cancelled', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const base = {
      tenantId: 'tenant-1',
      id: 'plan-1',
      version: 2,
      definitionDigest: 'pd-1',
      result: { stopped: true },
      appliedStepCount: 1,
      now: 10,
      audit,
    };
    await expectCasBoolean(batch, () => repo.failCancelledRunningPlan(base));
    const [update] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_configuration_plans SET status = 'failed', stage = 'verify', result_json = ?, applied_step_count = ?, failed_step_id = ?, failure_kind = 'plan_cancelled', last_transition_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ? AND status = 'running' AND definition_digest = ? AND cancelled_at IS NOT NULL"
    );
    expect(update.params).toEqual([
      '{"stopped":true}',
      1,
      null,
      'audit-1',
      10,
      'tenant-1',
      'plan-1',
      2,
      'pd-1',
    ]);
    expect(writer).toHaveBeenCalledWith(adapter, audit, PLAN_GUARD);
    await repo.failCancelledRunningPlan({ ...base, failedStepId: 'step-9' });
    expect(batchStatements(batch, 3)[0].params![2]).toBe('step-9');
  });

  it.each([
    [undefined, 100],
    [0, 1],
    [1000, 500],
    [250, 250],
  ])('purgeExpiredPayloads clamps limit %s to %s', async (limit, bound) => {
    const { repo, execute } = setup();
    execute.mockResolvedValueOnce({ rowsAffected: 4, success: true });
    await expect(repo.purgeExpiredPayloads(10, limit)).resolves.toBe(4);
    const [sql, params] = execute.mock.calls[0];
    expect(flat(sql)).toBe(
      'UPDATE agent_configuration_plans SET definition_json = NULL, snapshot_json = NULL, diff_json = NULL, validation_json = NULL, result_json = NULL, payload_purged_at = ?, updated_at = ? WHERE rowid IN ( SELECT rowid FROM agent_configuration_plans WHERE payload_purge_at <= ? AND payload_purged_at IS NULL LIMIT ? )'
    );
    expect(params).toEqual([10, 10, 10, bound]);
  });
});
