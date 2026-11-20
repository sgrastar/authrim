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

const baselineRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'bl-1',
  version: 1,
  control_tenant_id: 'control',
  name: 'Base',
  mode: 'managed',
  enforcement: 'standard_auto_remediation',
  definition_json: '{"rules":[]}',
  definition_digest: 'bd-1',
  status: 'active',
  created_by: 'admin-1',
  created_at: 5,
  ...overrides,
});

const assignmentColumns = {
  baseline_id: 'bl-1',
  baseline_version: 1,
  tenant_id: 'tenant-a',
  source_bulk_plan_id: 'bulk-1',
  source_bulk_plan_version: 2,
  assigned_by: 'admin-1',
  assigned_at: 10,
  last_evaluated_at: 20,
  drift_status: 'drifted',
  drift_digest: 'dd-1',
  remediation_bulk_plan_id: 'bulk-9',
  remediation_bulk_plan_version: 3,
  remediation_drift_digest: 'rd-1',
  remediation_requested_at: 30,
};
const nullAssignmentColumns = {
  last_evaluated_at: null,
  drift_status: null,
  drift_digest: null,
  remediation_bulk_plan_id: null,
  remediation_bulk_plan_version: null,
  remediation_drift_digest: null,
  remediation_requested_at: null,
};
const expectedAssignment = {
  id: 'as-1',
  baselineId: 'bl-1',
  baselineVersion: 1,
  tenantId: 'tenant-a',
  sourceBulkPlanId: 'bulk-1',
  sourceBulkPlanVersion: 2,
  assignedBy: 'admin-1',
  assignedAt: 10,
  lastEvaluatedAt: 20,
  driftStatus: 'drifted',
  driftDigest: 'dd-1',
  remediationBulkPlanId: 'bulk-9',
  remediationBulkPlanVersion: 3,
  remediationDriftDigest: 'rd-1',
  remediationRequestedAt: 30,
};
const undefinedAssignmentFields = {
  lastEvaluatedAt: undefined,
  driftStatus: undefined,
  driftDigest: undefined,
  remediationBulkPlanId: undefined,
  remediationBulkPlanVersion: undefined,
  remediationDriftDigest: undefined,
  remediationRequestedAt: undefined,
};

describe('AgentBaselineRepository baselines', () => {
  it('createBaseline inserts an active baseline', async () => {
    const { repo, batch, writer } = setup();
    await repo.createBaseline({
      id: 'bl-1',
      version: 1,
      controlTenantId: 'control',
      name: 'Base',
      mode: 'managed',
      enforcement: 'standard_auto_remediation',
      definition: { rules: [] } as never,
      definitionDigest: 'bd-1',
      createdBy: 'admin-1',
      createdAt: 5,
      audit: auditWrite(),
    });
    const [insert, audit] = batchStatements(batch);
    expect(flat(insert.sql)).toContain('INSERT INTO agent_baselines');
    expect(flat(insert.sql)).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)");
    expect(insert.params).toEqual([
      'bl-1',
      1,
      'control',
      'Base',
      'managed',
      'standard_auto_remediation',
      '{"rules":[]}',
      'bd-1',
      'admin-1',
      5,
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer.mock.calls[0][2]).toBeUndefined();
  });

  it('listBaselines maps rows and getBaseline matches id and version', async () => {
    const { repo, query } = setup();
    query.mockResolvedValue([baselineRow(), baselineRow({ version: 2, name: 'Base v2' })]);
    await expect(repo.listBaselines('control')).resolves.toEqual([
      {
        id: 'bl-1',
        version: 1,
        controlTenantId: 'control',
        name: 'Base',
        mode: 'managed',
        enforcement: 'standard_auto_remediation',
        definition: { rules: [] },
        definitionDigest: 'bd-1',
        status: 'active',
        createdBy: 'admin-1',
        createdAt: 5,
      },
      expect.objectContaining({ version: 2 }),
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toBe(
      'SELECT * FROM agent_baselines WHERE control_tenant_id = ? ORDER BY created_at DESC, id, version DESC'
    );
    expect(params).toEqual(['control']);
    await expect(repo.getBaseline('control', 'bl-1', 2)).resolves.toMatchObject({
      name: 'Base v2',
    });
    await expect(repo.getBaseline('control', 'bl-1', 3)).resolves.toBeNull();
    await expect(repo.getBaseline('control', 'bl-x', 1)).resolves.toBeNull();
  });
});

describe('AgentBaselineRepository assignments', () => {
  it('assignBaseline requires an active baseline and a succeeded rollout to the tenant', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.assignBaseline({
        id: 'as-1',
        controlTenantId: 'control',
        baselineId: 'bl-1',
        baselineVersion: 1,
        tenantId: 'tenant-a',
        sourceBulkPlanId: 'bulk-1',
        sourceBulkPlanVersion: 2,
        assignedBy: 'admin-1',
        assignedAt: 10,
        audit,
      });
    await expectCas(batch, run);
    const [insert, auditStatement] = batchStatements(batch);
    const sql = flat(insert.sql);
    expect(sql).toContain("SELECT ?, b.id, b.version, ?, p.id, p.version, ?, ?, 'unknown'");
    expect(sql).toContain(
      'ON p.id = ? AND p.version = ? AND p.control_tenant_id = b.control_tenant_id'
    );
    expect(sql).toContain(
      "WHERE b.control_tenant_id = ? AND b.id = ? AND b.version = ? AND b.status = 'active' AND p.status = 'completed'"
    );
    expect(sql).toContain("AND e.target_tenant_id = ? AND e.status = 'succeeded')");
    expect(insert.params).toEqual([
      'as-1',
      'tenant-a',
      'admin-1',
      10,
      'bulk-1',
      2,
      'control',
      'bl-1',
      1,
      'tenant-a',
    ]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_baseline_assignments',
      where: 'id = ? AND baseline_id = ? AND baseline_version = ?',
      params: ['as-1', 'bl-1', 1],
    });
  });

  it('listAssignments scopes by control tenant and maps nullable drift columns', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([
      { id: 'as-1', ...assignmentColumns },
      { id: 'as-2', ...assignmentColumns, ...nullAssignmentColumns },
    ]);
    const rows = await repo.listAssignments('control', 'bl-1', 1);
    expect(rows).toEqual([
      expectedAssignment,
      { ...expectedAssignment, id: 'as-2', ...undefinedAssignmentFields },
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain(
      'WHERE b.control_tenant_id = ? AND a.baseline_id = ? AND a.baseline_version = ? ORDER BY a.tenant_id'
    );
    expect(params).toEqual(['control', 'bl-1', 1]);
  });

  it('getAssignmentContext returns the assignment and its baseline', async () => {
    const { repo, queryOne } = setup();
    const contextRow = {
      assignment_id: 'as-1',
      ...assignmentColumns,
      control_tenant_id: 'control',
      baseline_name: 'Base',
      baseline_mode: 'managed',
      baseline_enforcement: 'report_only',
      definition_json: '{"rules":[1]}',
      definition_digest: 'bd-1',
      baseline_status: 'archived',
      baseline_created_by: 'admin-2',
      baseline_created_at: 3,
    };
    queryOne.mockResolvedValueOnce(contextRow);
    await expect(repo.getAssignmentContext('control', 'as-1')).resolves.toEqual({
      assignment: expectedAssignment,
      baseline: {
        id: 'bl-1',
        version: 1,
        controlTenantId: 'control',
        name: 'Base',
        mode: 'managed',
        enforcement: 'report_only',
        definition: { rules: [1] },
        definitionDigest: 'bd-1',
        status: 'archived',
        createdBy: 'admin-2',
        createdAt: 3,
      },
    });
    const [sql, params] = queryOne.mock.calls[0];
    expect(flat(sql)).toContain('WHERE b.control_tenant_id = ? AND a.id = ?');
    expect(params).toEqual(['control', 'as-1']);

    queryOne.mockResolvedValueOnce({ ...contextRow, ...nullAssignmentColumns });
    const context = await repo.getAssignmentContext('control', 'as-1');
    expect(context?.assignment).toEqual({ ...expectedAssignment, ...undefinedAssignmentFields });
    await expect(repo.getAssignmentContext('control', 'as-1')).resolves.toBeNull();
  });

  it('evaluateAssignment records drift and returns the status only when one row changed', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const input = {
      controlTenantId: 'control',
      assignmentId: 'as-1',
      status: 'in_sync' as const,
      currentDigest: 'dd-2',
      evaluatedAt: 40,
      audit,
    };
    await expect(repo.evaluateAssignment(input)).resolves.toBe('in_sync');
    const [update, auditStatement] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      'UPDATE agent_baseline_assignments SET last_evaluated_at = ?, drift_status = ?, drift_digest = ?, last_transition_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM agent_baselines b WHERE b.id = agent_baseline_assignments.baseline_id AND b.version = agent_baseline_assignments.baseline_version AND b.control_tenant_id = ?)'
    );
    expect(update.params).toEqual([40, 'in_sync', 'dd-2', 'audit-1', 'as-1', 'control']);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_baseline_assignments',
      where: 'id = ? AND last_transition_id = ?',
      params: ['as-1', 'audit-1'],
    });
    batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
    await expect(repo.evaluateAssignment(input)).resolves.toBeNull();
    batch.mockResolvedValueOnce([]);
    await expect(repo.evaluateAssignment(input)).resolves.toBeNull();
  });
});
