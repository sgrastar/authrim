import { describe, expect, it } from 'vitest';
import { AgentBaselineRepository } from '../core/repositories/agent-baseline-repository';
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
  return { ...db, writer, repo: new AgentBaselineRepository(db.adapter, writer) };
}

async function expectCas(
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

const ASSIGNMENT_GUARD = {
  from: 'agent_baseline_assignments',
  where: 'id = ? AND last_transition_id = ?',
  params: ['as-1', 'audit-1'],
};

describe('AgentBaselineRepository managed evaluation', () => {
  it.each([
    [{ minimumIntervalMs: 0 }, 1_000_000 - 60_000, 25],
    [{ minimumIntervalMs: 120_000, limit: 0 }, 1_000_000 - 120_000, 1],
    [{ minimumIntervalMs: 59_999, limit: 500 }, 1_000_000 - 60_000, 100],
    [{ minimumIntervalMs: 60_000, limit: 40 }, 1_000_000 - 60_000, 40],
  ])(
    'listManagedEvaluationCandidates binds cutoff and limit for %j',
    async (opts, cutoff, limit) => {
      const { repo, query } = setup();
      query.mockResolvedValueOnce([
        { control_tenant_id: 'control', assignment_id: 'as-1', last_evaluated_at: 5 },
        { control_tenant_id: 'control', assignment_id: 'as-2', last_evaluated_at: null },
      ]);
      await expect(
        repo.listManagedEvaluationCandidates({ now: 1_000_000, ...opts })
      ).resolves.toEqual([
        { controlTenantId: 'control', assignmentId: 'as-1', lastEvaluatedAt: 5 },
        { controlTenantId: 'control', assignmentId: 'as-2', lastEvaluatedAt: undefined },
      ]);
      const [sql, params] = query.mock.calls[0];
      expect(flat(sql)).toContain(
        "WHERE b.status = 'active' AND b.mode = 'managed' AND (a.last_evaluated_at IS NULL OR a.last_evaluated_at <= ?) ORDER BY COALESCE(a.last_evaluated_at, 0), a.id LIMIT ?"
      );
      expect(params).toEqual([cutoff, limit]);
    }
  );

  const managedInput = {
    controlTenantId: 'control',
    assignmentId: 'as-1',
    status: 'drifted' as const,
    currentDigest: 'dd-3',
    evaluatedAt: 50,
    audit: auditWrite(),
  };

  it('evaluateManagedAssignment requires a never-evaluated row when no expectation is given', async () => {
    const { repo, batch, writer, adapter } = setup();
    await expectCas(batch, () => repo.evaluateManagedAssignment(managedInput));
    const [update, audit] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_baseline_assignments SET last_evaluated_at = ?, drift_status = ?, drift_digest = ?, last_transition_id = ? WHERE id = ? AND last_evaluated_at IS NULL AND EXISTS (SELECT 1 FROM agent_baselines b WHERE b.id = agent_baseline_assignments.baseline_id AND b.version = agent_baseline_assignments.baseline_version AND b.control_tenant_id = ? AND b.status = 'active' AND b.mode = 'managed')"
    );
    expect(update.params).toEqual([
      50,
      'drifted',
      'dd-3',
      managedInput.audit.id,
      'as-1',
      'control',
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, managedInput.audit, ASSIGNMENT_GUARD);
  });

  it('evaluateManagedAssignment compares against the expected last evaluation', async () => {
    const { repo, batch } = setup();
    await repo.evaluateManagedAssignment({ ...managedInput, expectedLastEvaluatedAt: 0 });
    const [update] = batchStatements(batch);
    expect(flat(update.sql)).toContain('WHERE id = ? AND last_evaluated_at = ? AND EXISTS');
    expect(update.params).toEqual([
      50,
      'drifted',
      'dd-3',
      managedInput.audit.id,
      'as-1',
      0,
      'control',
    ]);
  });
});

describe('AgentBaselineRepository auto remediation', () => {
  it('reserveAutoRemediation reserves drifted standard_auto_remediation assignments', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.reserveAutoRemediation({
        controlTenantId: 'control',
        assignmentId: 'as-1',
        driftDigest: 'dd-4',
        bulkPlanId: 'bulk-5',
        bulkPlanVersion: 1,
        requestedAt: 60,
        audit,
      });
    await expectCas(batch, run);
    const [update, auditStatement] = batchStatements(batch);
    const sql = flat(update.sql);
    expect(sql).toContain(
      'SET remediation_bulk_plan_id = ?, remediation_bulk_plan_version = ?, remediation_drift_digest = ?, remediation_requested_at = ?, last_transition_id = ?'
    );
    expect(sql).toContain("WHERE id = ? AND drift_status = 'drifted' AND drift_digest = ?");
    expect(sql).toContain(
      "AND (remediation_bulk_plan_id IS NULL OR ( remediation_drift_digest <> ? AND EXISTS ( SELECT 1 FROM agent_bulk_plans previous WHERE previous.id = remediation_bulk_plan_id AND previous.version = remediation_bulk_plan_version AND previous.status = 'completed' ) ))"
    );
    expect(sql).toContain(
      "AND b.control_tenant_id = ? AND b.status = 'active' AND b.mode = 'managed' AND b.enforcement = 'standard_auto_remediation')"
    );
    expect(update.params).toEqual([
      'bulk-5',
      1,
      'dd-4',
      60,
      'audit-1',
      'as-1',
      'dd-4',
      'dd-4',
      'control',
    ]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, ASSIGNMENT_GUARD);
  });

  it.each([
    [undefined, 25],
    [0, 1],
    [101, 100],
    [7, 7],
  ])('listPendingAutoRemediations clamps limit %s to %s', async (limit, bound) => {
    const { repo, query } = setup();
    const rows = [{ controlTenantId: 'control', assignmentId: 'as-1' }];
    query.mockResolvedValueOnce(rows);
    await expect(repo.listPendingAutoRemediations(limit)).resolves.toBe(rows);
    const [sql, params] = query.mock.calls[0];
    const text = flat(sql);
    expect(text).toContain(
      'SELECT b.control_tenant_id AS controlTenantId, a.id AS assignmentId FROM agent_baseline_assignments a'
    );
    expect(text).toContain(
      "WHERE b.status = 'active' AND b.mode = 'managed' AND b.enforcement = 'standard_auto_remediation' AND a.remediation_drift_digest IS NOT NULL AND a.remediation_bulk_plan_id IS NOT NULL AND (p.id IS NULL OR p.status IN ('draft', 'ready')) ORDER BY a.remediation_requested_at, a.id LIMIT ?"
    );
    expect(params).toEqual([bound]);
  });
});

describe('AgentBaselineRepository exceptions', () => {
  it('createException only attaches to managed assignments without an open remediation', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.createException({
        id: 'ex-1',
        controlTenantId: 'control',
        assignmentId: 'as-1',
        fields: ['mfa', 'scopes'],
        reason: 'pilot',
        approvedBy: 'admin-1',
        approvedAt: 70,
        expiresAt: 700,
        audit,
      });
    await expectCas(batch, run);
    const [insert, auditStatement] = batchStatements(batch);
    const sql = flat(insert.sql);
    expect(sql).toContain('INSERT INTO agent_baseline_exceptions');
    expect(sql).toContain("WHERE a.id = ? AND b.control_tenant_id = ? AND b.mode = 'managed'");
    expect(sql).toContain(
      "AND (a.remediation_bulk_plan_id IS NULL OR EXISTS ( SELECT 1 FROM agent_bulk_plans p WHERE p.id = a.remediation_bulk_plan_id AND p.version = a.remediation_bulk_plan_version AND p.status = 'completed' ))"
    );
    expect(insert.params).toEqual([
      'ex-1',
      '["mfa","scopes"]',
      'pilot',
      'admin-1',
      70,
      700,
      'as-1',
      'control',
    ]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_baseline_exceptions',
      where: 'id = ? AND assignment_id = ?',
      params: ['ex-1', 'as-1'],
    });
  });

  it('listExceptions returns only unrevoked, unexpired exceptions for the tenant', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([
      {
        id: 'ex-1',
        assignment_id: 'as-1',
        fields_json: '["mfa"]',
        reason: 'pilot',
        approved_by: 'admin-1',
        approved_at: 70,
        expires_at: 700,
        revoked_at: null,
      },
      {
        id: 'ex-2',
        assignment_id: 'as-1',
        fields_json: '[]',
        reason: 'r',
        approved_by: 'admin-1',
        approved_at: 60,
        expires_at: 700,
        revoked_at: 65,
      },
    ]);
    await expect(repo.listExceptions('control', 'as-1', 100)).resolves.toEqual([
      {
        id: 'ex-1',
        assignmentId: 'as-1',
        fields: ['mfa'],
        reason: 'pilot',
        approvedBy: 'admin-1',
        approvedAt: 70,
        expiresAt: 700,
        revokedAt: undefined,
      },
      expect.objectContaining({ id: 'ex-2', fields: [], revokedAt: 65 }),
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain(
      'WHERE b.control_tenant_id = ? AND x.assignment_id = ? AND x.revoked_at IS NULL AND x.expires_at > ? ORDER BY x.approved_at DESC'
    );
    expect(params).toEqual(['control', 'as-1', 100]);
  });
});
