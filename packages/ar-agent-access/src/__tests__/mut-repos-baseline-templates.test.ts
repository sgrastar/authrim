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

const templateRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  version: 2,
  source_tenant_id: 'control',
  template_type: 'task_set',
  source_object_id: 'ts-1',
  source_object_version: 3,
  definition_json: JSON.stringify({
    name: 'Readers',
    description: 'read only',
    tools: [{ id: 'tool.read' }],
    permissions: ['users:read'],
    catalog_version: 'cat-9',
  }),
  definition_digest: 'td-1',
  status: 'active',
  published_by: 'admin-1',
  published_at: 77,
  ...overrides,
});

const copyInput = {
  id: 'copy-1',
  templateId: 'tpl-1',
  templateVersion: 2,
  targetTenantId: 'tenant-a',
  targetObjectId: 'obj-1',
  bulkPlanId: 'bulk-1',
  bulkPlanVersion: 4,
  copiedBy: 'admin-1',
  copiedAt: 900,
  audit: auditWrite(),
};

const ok = { rowsAffected: 1, success: true };
const none = { rowsAffected: 0, success: true };

describe('AgentBaselineRepository templates', () => {
  it('publishTemplate inserts an active template and its audit', async () => {
    const { repo, batch, writer } = setup();
    await repo.publishTemplate({
      id: 'tpl-1',
      version: 2,
      sourceTenantId: 'control',
      templateType: 'scope_policy',
      sourceObjectId: 'sp-1',
      sourceObjectVersion: 3,
      definition: { name: 'x' },
      definitionDigest: 'td-1',
      publishedBy: 'admin-1',
      publishedAt: 77,
      audit: auditWrite(),
    });
    const [insert, audit] = batchStatements(batch);
    expect(flat(insert.sql)).toContain('INSERT INTO agent_configuration_templates');
    expect(flat(insert.sql)).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)");
    expect(insert.params).toEqual([
      'tpl-1',
      2,
      'control',
      'scope_policy',
      'sp-1',
      3,
      '{"name":"x"}',
      'td-1',
      'admin-1',
      77,
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer.mock.calls[0][2]).toBeUndefined();
  });

  const expectedTemplate = {
    id: 'tpl-1',
    version: 2,
    sourceTenantId: 'control',
    templateType: 'task_set',
    sourceObjectId: 'ts-1',
    sourceObjectVersion: 3,
    definition: {
      name: 'Readers',
      description: 'read only',
      tools: [{ id: 'tool.read' }],
      permissions: ['users:read'],
      catalog_version: 'cat-9',
    },
    definitionDigest: 'td-1',
    status: 'active',
    publishedBy: 'admin-1',
    publishedAt: 77,
  };

  it('listTemplates maps rows for one source tenant', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([templateRow()]);
    await expect(repo.listTemplates('control')).resolves.toEqual([expectedTemplate]);
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toBe(
      'SELECT * FROM agent_configuration_templates WHERE source_tenant_id = ? ORDER BY published_at DESC, id, version DESC'
    );
    expect(params).toEqual(['control']);
  });

  it('getTemplate maps one row and returns null when absent', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce(templateRow());
    await expect(repo.getTemplate('tpl-1', 2)).resolves.toEqual(expectedTemplate);
    expect(queryOne.mock.calls[0]).toEqual([
      'SELECT * FROM agent_configuration_templates WHERE id = ? AND version = ?',
      ['tpl-1', 2],
    ]);
    await expect(repo.getTemplate('tpl-1', 3)).resolves.toBeNull();
  });

  it('copyTemplate refuses missing, retired or unnamed templates without writing', async () => {
    const { repo, queryOne, batch } = setup();
    await expect(repo.copyTemplate(copyInput)).resolves.toBe(false);
    queryOne.mockResolvedValueOnce(templateRow({ status: 'retired' }));
    await expect(repo.copyTemplate(copyInput)).resolves.toBe(false);
    queryOne.mockResolvedValueOnce(templateRow({ definition_json: '{"name":""}' }));
    await expect(repo.copyTemplate(copyInput)).resolves.toBe(false);
    queryOne.mockResolvedValueOnce(templateRow({ definition_json: '{"name":42}' }));
    await expect(repo.copyTemplate(copyInput)).resolves.toBe(false);
    expect(batch).not.toHaveBeenCalled();
  });

  it('copyTemplate copies a task set as an archived template_copy gated on a succeeded rollout', async () => {
    const { repo, queryOne, batch, writer, adapter } = setup();
    queryOne.mockResolvedValue(templateRow());
    batch.mockResolvedValueOnce([ok, ok, ok, ok]);
    await expect(repo.copyTemplate(copyInput)).resolves.toBe(true);
    const statements = batchStatements(batch);
    expect(statements).toHaveLength(4);
    const [set, version, copy, audit] = statements;
    const setSql = flat(set.sql);
    expect(setSql).toContain('INSERT INTO agent_task_sets');
    expect(setSql).toContain("SELECT ?, ?, ?, ?, 'template_copy', 'archived', 1, ?, ?, ?, ?, ?");
    expect(setSql).toContain(
      "WHERE EXISTS (SELECT 1 FROM agent_configuration_templates WHERE id = ? AND version = ? AND status = 'active')"
    );
    expect(setSql).toContain(
      "WHERE p.id = ? AND p.version = ? AND p.status = 'completed' AND e.target_tenant_id = ? AND e.status = 'succeeded')"
    );
    expect(set.params).toEqual([
      'obj-1',
      'tenant-a',
      'Readers',
      'read only',
      'tpl-1',
      2,
      'admin-1',
      900,
      900,
      'tpl-1',
      2,
      'bulk-1',
      4,
      'tenant-a',
    ]);
    expect(flat(version.sql)).toContain('INSERT INTO agent_task_set_versions');
    expect(flat(version.sql)).toContain(
      "SELECT ?, 1, ?, ?, ?, ?, 'archived', ?, ? WHERE EXISTS (SELECT 1 FROM agent_task_sets WHERE id = ? AND status = 'archived')"
    );
    expect(version.params).toEqual([
      'obj-1',
      '[{"id":"tool.read"}]',
      '["users:read"]',
      'td-1',
      'cat-9',
      'admin-1',
      900,
      'obj-1',
    ]);
    const copySql = flat(copy.sql);
    expect(copySql).toContain('INSERT INTO agent_template_copies');
    expect(copySql).toContain(
      "SELECT ?, t.id, t.version, ?, ?, 1, 'inactive', p.id, p.version, ?, ?"
    );
    expect(copySql).toContain("ON p.id = ? AND p.version = ? AND p.status = 'completed'");
    expect(copySql).toContain("WHERE t.id = ? AND t.version = ? AND t.status = 'active'");
    expect(copySql).toContain("AND e.target_tenant_id = ? AND e.status = 'succeeded')");
    expect(copy.params).toEqual([
      'copy-1',
      'tenant-a',
      'obj-1',
      'admin-1',
      900,
      'bulk-1',
      4,
      'tpl-1',
      2,
      'tenant-a',
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, copyInput.audit, {
      from: 'agent_template_copies',
      where: 'id = ? AND template_id = ? AND template_version = ?',
      params: ['copy-1', 'tpl-1', 2],
    });
  });

  it('copyTemplate defaults missing task-set fields', async () => {
    const { repo, queryOne, batch } = setup();
    queryOne.mockResolvedValue(templateRow({ definition_json: '{"name":"Bare","description":7}' }));
    batch.mockResolvedValueOnce([ok, ok, ok]);
    await repo.copyTemplate(copyInput);
    const [set, version] = batchStatements(batch);
    expect(set.params![3]).toBeNull();
    expect(version.params!.slice(1, 5)).toEqual(['[]', '[]', 'td-1', 'unknown']);
  });

  it.each([
    [[none, ok, ok]],
    [[ok, none, ok]],
    [[ok, ok, none]],
    [[ok, ok]],
    [[ok, { rowsAffected: 2, success: true }, ok]],
  ])('copyTemplate reports failure when any write misses: %j', async (results) => {
    const { repo, queryOne, batch } = setup();
    queryOne.mockResolvedValue(templateRow());
    batch.mockResolvedValueOnce(results);
    await expect(repo.copyTemplate(copyInput)).resolves.toBe(false);
  });

  it('copyTemplate copies a scope policy with its own statements', async () => {
    const { repo, queryOne, batch } = setup();
    queryOne.mockResolvedValue(
      templateRow({
        template_type: 'scope_policy',
        definition_json: JSON.stringify({
          name: 'Scope',
          definition: { tenantIds: ['tenant-a'] },
          selector_catalog_version: 'sel-3',
        }),
      })
    );
    batch.mockResolvedValueOnce([ok, ok, ok, ok]);
    await expect(repo.copyTemplate(copyInput)).resolves.toBe(true);
    const [policy, version] = batchStatements(batch);
    const policySql = flat(policy.sql);
    expect(policySql).toContain('INSERT INTO agent_scope_policies');
    expect(policySql).toContain("SELECT ?, ?, ?, ?, 'template_copy', 'archived', 1, ?, ?, ?, ?, ?");
    expect(policySql).toContain(
      "WHERE EXISTS (SELECT 1 FROM agent_configuration_templates WHERE id = ? AND version = ? AND status = 'active')"
    );
    expect(policySql).toContain(
      "WHERE p.id = ? AND p.version = ? AND p.status = 'completed' AND e.target_tenant_id = ? AND e.status = 'succeeded')"
    );
    expect(policy.params).toEqual([
      'obj-1',
      'tenant-a',
      'Scope',
      null,
      'tpl-1',
      2,
      'admin-1',
      900,
      900,
      'tpl-1',
      2,
      'bulk-1',
      4,
      'tenant-a',
    ]);
    expect(flat(version.sql)).toContain('INSERT INTO agent_scope_policy_versions');
    expect(flat(version.sql)).toContain(
      "SELECT ?, 1, ?, ?, ?, 'archived', ?, ? WHERE EXISTS (SELECT 1 FROM agent_scope_policies WHERE id = ? AND status = 'archived')"
    );
    expect(version.params).toEqual([
      'obj-1',
      '{"tenantIds":["tenant-a"]}',
      'td-1',
      'sel-3',
      'admin-1',
      900,
      'obj-1',
    ]);
  });

  it('copyTemplate defaults a bare scope policy definition', async () => {
    const { repo, queryOne, batch } = setup();
    queryOne.mockResolvedValue(
      templateRow({ template_type: 'scope_policy', definition_json: '{"name":"Bare"}' })
    );
    batch.mockResolvedValueOnce([ok, ok, ok]);
    await repo.copyTemplate(copyInput);
    expect(batchStatements(batch)[1].params!.slice(1, 4)).toEqual(['{}', 'td-1', 'unknown']);
  });

  it('listTemplateCopies maps copy rows ordered by tenant', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([
      {
        id: 'copy-1',
        template_id: 'tpl-1',
        template_version: 2,
        target_tenant_id: 'tenant-a',
        target_object_id: 'obj-1',
        target_object_version: 1,
        target_object_status: 'inactive',
        bulk_plan_id: 'bulk-1',
        bulk_plan_version: 4,
        copied_by: 'admin-1',
        copied_at: 900,
      },
    ]);
    await expect(repo.listTemplateCopies('tpl-1', 2)).resolves.toEqual([
      {
        id: 'copy-1',
        templateId: 'tpl-1',
        templateVersion: 2,
        targetTenantId: 'tenant-a',
        targetObjectId: 'obj-1',
        targetObjectVersion: 1,
        targetObjectStatus: 'inactive',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 4,
        copiedBy: 'admin-1',
        copiedAt: 900,
      },
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toBe(
      'SELECT * FROM agent_template_copies WHERE template_id = ? AND template_version = ? ORDER BY target_tenant_id'
    );
    expect(params).toEqual(['tpl-1', 2]);
  });
});
