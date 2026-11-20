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

const resolved = {
  catalogVersion: 'catalog-1',
  tools: [{ id: 'tool.read', version: '1' }],
  permissions: ['users:read'],
  digest: 'digest-1',
} as never;

const taskSetRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ts-1',
  tenant_id: 'tenant-1',
  name: 'Readers',
  description: null,
  kind: 'custom',
  management_mode: 'managed',
  status: 'active',
  current_version: 2,
  tool_entries_json: '[{"id":"tool.read"}]',
  resolved_permissions_json: '["users:read"]',
  definition_digest: 'd-1',
  catalog_version: 'c-1',
  created_at: 10,
  updated_at: 20,
  ...overrides,
});

describe('AgentConfigurationRepository audit plumbing', () => {
  it('writeAudit batches the statements produced by the writer without a guard', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    await repo.writeAudit(audit);
    expect(writer).toHaveBeenCalledWith(adapter, audit, undefined);
    expect(batch).toHaveBeenCalledWith([AUDIT_STATEMENT]);
  });

  it('refuses to write without an audit writer', async () => {
    const db = fakeAdapter();
    const repo = new AgentConfigurationRepository(db.adapter);
    await expect(repo.writeAudit(auditWrite())).rejects.toThrow(
      'admin_agent_audit_writer_required'
    );
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe('AgentConfigurationRepository.isActiveTenant', () => {
  it('queries only active tenants and requires the returned id to match', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce({ id: 'tenant-1' });
    await expect(repo.isActiveTenant('tenant-1')).resolves.toBe(true);
    const [sql, params] = queryOne.mock.calls[0];
    expect(flat(sql)).toContain("FROM tenants WHERE id = ? AND lifecycle_state = 'active'");
    expect(params).toEqual(['tenant-1']);
  });

  it('returns false for a missing or mismatching row', async () => {
    const { repo, queryOne } = setup();
    await expect(repo.isActiveTenant('tenant-1')).resolves.toBe(false);
    queryOne.mockResolvedValueOnce({ id: 'tenant-2' });
    await expect(repo.isActiveTenant('tenant-1')).resolves.toBe(false);
  });
});

describe('AgentConfigurationRepository task sets', () => {
  it('createTaskSet inserts the set, version 1 and the audit in one batch', async () => {
    const { repo, batch, writer } = setup();
    const audit = auditWrite();
    await repo.createTaskSet({
      id: 'ts-1',
      tenantId: 'tenant-1',
      name: 'Readers',
      kind: 'custom',
      resolved,
      createdBy: 'admin-1',
      now: 500,
      audit,
    });
    const statements = batchStatements(batch);
    expect(statements).toHaveLength(3);
    expect(flat(statements[0].sql)).toContain('INSERT INTO agent_task_sets');
    expect(flat(statements[0].sql)).toContain("VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)");
    expect(statements[0].params).toEqual([
      'ts-1',
      'tenant-1',
      'Readers',
      null,
      'custom',
      'admin-1',
      'audit-1',
      500,
      500,
    ]);
    expect(flat(statements[1].sql)).toContain('INSERT INTO agent_task_set_versions');
    expect(flat(statements[1].sql)).toContain("VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?)");
    expect(statements[1].params).toEqual([
      'ts-1',
      '[{"id":"tool.read","version":"1"}]',
      '["users:read"]',
      'digest-1',
      'catalog-1',
      'admin-1',
      500,
    ]);
    expect(statements[2]).toBe(AUDIT_STATEMENT);
    expect(writer.mock.calls[0][2]).toBeUndefined();
  });

  it('createTaskSet keeps a provided description', async () => {
    const { repo, batch } = setup();
    await repo.createTaskSet({
      id: 'ts-1',
      tenantId: 'tenant-1',
      name: 'Readers',
      description: 'read only',
      kind: 'template_copy',
      resolved,
      createdBy: 'admin-1',
      now: 1,
      audit: auditWrite(),
    });
    expect(batchStatements(batch)[0].params![3]).toBe('read only');
  });

  it('listTaskSets hides system-managed sets unless asked and maps rows', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([taskSetRow()]);
    const [record] = await repo.listTaskSets('tenant-1');
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain(
      "WHERE s.tenant_id = ? AND s.management_mode = 'managed' ORDER BY s.name, s.id"
    );
    expect(flat(sql)).toContain('ON v.task_set_id = s.id AND v.version = s.current_version');
    expect(params).toEqual(['tenant-1']);
    expect(record).toEqual({
      id: 'ts-1',
      tenantId: 'tenant-1',
      name: 'Readers',
      description: undefined,
      kind: 'custom',
      managementMode: 'managed',
      status: 'active',
      currentVersion: 2,
      version: {
        tools: [{ id: 'tool.read' }],
        permissions: ['users:read'],
        digest: 'd-1',
        catalogVersion: 'c-1',
      },
      createdAt: 10,
      updatedAt: 20,
    });

    await repo.listTaskSets('tenant-1', { includeSystemManaged: true });
    expect(flat(query.mock.calls[1][0])).not.toContain('management_mode = ');
    expect(flat(query.mock.calls[1][0])).toContain('WHERE s.tenant_id = ? ORDER BY');
  });

  it('getTaskSet includes system-managed sets and selects by id', async () => {
    const { repo, query } = setup();
    query.mockResolvedValue([
      taskSetRow({ id: 'ts-0', description: 'x' }),
      taskSetRow({ id: 'ts-1', management_mode: 'system_managed' }),
    ]);
    await expect(repo.getTaskSet('tenant-1', 'ts-1')).resolves.toMatchObject({
      id: 'ts-1',
      managementMode: 'system_managed',
    });
    expect(flat(query.mock.calls[0][0])).not.toContain("management_mode = 'managed'");
    await expect(repo.getTaskSet('tenant-1', 'missing')).resolves.toBeNull();
  });

  it('getTaskSetVersion reads an active version and reports it as current', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce(taskSetRow({ description: 'kept' }));
    await expect(repo.getTaskSetVersion('tenant-1', 'ts-1', 1)).resolves.toMatchObject({
      currentVersion: 1,
      description: 'kept',
    });
    const [sql, params] = queryOne.mock.calls[0];
    expect(flat(sql)).toContain(
      "WHERE s.tenant_id = ? AND s.id = ? AND v.version = ? AND v.status = 'active'"
    );
    expect(params).toEqual(['tenant-1', 'ts-1', 1]);
    await expect(repo.getTaskSetVersion('tenant-1', 'ts-1', 9)).resolves.toBeNull();
  });

  it('createTaskSetVersion advances under a compare-and-swap and guards the audit', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite({ id: 'audit-7' });
    const input = {
      tenantId: 'tenant-1',
      id: 'ts-1',
      expectedVersion: 4,
      resolved,
      createdBy: 'admin-1',
      now: 900,
      audit,
    };
    await expect(repo.createTaskSetVersion(input)).resolves.toBe(true);
    const [update, insert, auditStatement] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_task_sets SET current_version = ?, last_transition_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'active' AND current_version = ?"
    );
    expect(update.params).toEqual([5, 'audit-7', 900, 'tenant-1', 'ts-1', 4]);
    expect(flat(insert.sql)).toContain(
      "SELECT id, ?, ?, ?, ?, ?, 'active', ?, ? FROM agent_task_sets WHERE tenant_id = ? AND id = ? AND last_transition_id = ?"
    );
    expect(insert.params).toEqual([
      5,
      '[{"id":"tool.read","version":"1"}]',
      '["users:read"]',
      'digest-1',
      'catalog-1',
      'admin-1',
      900,
      'tenant-1',
      'ts-1',
      'audit-7',
    ]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_task_sets',
      where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
      params: ['tenant-1', 'ts-1', 'audit-7'],
    });

    batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
    await expect(repo.createTaskSetVersion(input)).resolves.toBe(false);
    batch.mockResolvedValueOnce([]);
    await expect(repo.createTaskSetVersion(input)).resolves.toBe(false);
    batch.mockResolvedValueOnce([{ rowsAffected: 2, success: true }]);
    await expect(repo.createTaskSetVersion(input)).resolves.toBe(false);
  });

  it('suspendTaskSetVersion suspends only an active version owned by the tenant', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const input = { tenantId: 'tenant-1', id: 'ts-1', version: 2, audit };
    await expect(repo.suspendTaskSetVersion(input)).resolves.toBe(true);
    const [update] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_task_set_versions SET status = 'suspended', last_transition_id = ? WHERE task_set_id = ? AND version = ? AND status = 'active' AND EXISTS (SELECT 1 FROM agent_task_sets WHERE id = agent_task_set_versions.task_set_id AND tenant_id = ?)"
    );
    expect(update.params).toEqual(['audit-1', 'ts-1', 2, 'tenant-1']);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_task_set_versions v JOIN agent_task_sets s ON s.id = v.task_set_id',
      where: 's.tenant_id = ? AND v.task_set_id = ? AND v.version = ? AND v.last_transition_id = ?',
      params: ['tenant-1', 'ts-1', 2, 'audit-1'],
    });
    batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
    await expect(repo.suspendTaskSetVersion(input)).resolves.toBe(false);
    batch.mockResolvedValueOnce([]);
    await expect(repo.suspendTaskSetVersion(input)).resolves.toBe(false);
  });
});
