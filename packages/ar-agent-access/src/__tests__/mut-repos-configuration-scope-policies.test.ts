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

const scopeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'sp-1',
  tenant_id: 'tenant-1',
  name: 'Scope',
  description: 'desc',
  kind: 'builtin',
  management_mode: 'system_managed',
  status: 'archived',
  current_version: 3,
  definition_json: '{"tenantIds":["tenant-1"]}',
  definition_digest: 'sd-1',
  selector_catalog_version: 'sel-1',
  created_at: 11,
  updated_at: 21,
  ...overrides,
});

describe('AgentConfigurationRepository scope policies', () => {
  const definition = { tenantIds: ['tenant-1'] } as never;

  it('createScopePolicy inserts the policy and its first version', async () => {
    const { repo, batch, writer } = setup();
    await repo.createScopePolicy({
      id: 'sp-1',
      tenantId: 'tenant-1',
      name: 'Scope',
      kind: 'custom',
      definition,
      definitionDigest: 'sd-1',
      selectorCatalogVersion: 'sel-1',
      createdBy: 'admin-1',
      now: 42,
      audit: auditWrite(),
    });
    const [policy, version, audit] = batchStatements(batch);
    expect(flat(policy.sql)).toContain('INSERT INTO agent_scope_policies');
    expect(flat(policy.sql)).toContain("VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)");
    expect(policy.params).toEqual([
      'sp-1',
      'tenant-1',
      'Scope',
      null,
      'custom',
      'admin-1',
      'audit-1',
      42,
      42,
    ]);
    expect(flat(version.sql)).toContain('INSERT INTO agent_scope_policy_versions');
    expect(flat(version.sql)).toContain("VALUES (?, 1, ?, ?, ?, 'active', ?, ?)");
    expect(version.params).toEqual([
      'sp-1',
      '{"tenantIds":["tenant-1"]}',
      'sd-1',
      'sel-1',
      'admin-1',
      42,
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer.mock.calls[0][2]).toBeUndefined();
  });

  it('createScopePolicy keeps a provided description', async () => {
    const { repo, batch } = setup();
    await repo.createScopePolicy({
      id: 'sp-1',
      tenantId: 'tenant-1',
      name: 'Scope',
      description: 'about',
      kind: 'custom',
      definition,
      definitionDigest: 'sd-1',
      selectorCatalogVersion: 'sel-1',
      createdBy: 'admin-1',
      now: 42,
      audit: auditWrite(),
    });
    expect(batchStatements(batch)[0].params![3]).toBe('about');
  });

  it('listScopePolicies filters managed policies by default and maps rows', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([scopeRow()]);
    const [record] = await repo.listScopePolicies('tenant-1');
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain(
      "WHERE p.tenant_id = ? AND p.management_mode = 'managed' ORDER BY p.name, p.id"
    );
    expect(flat(sql)).toContain('ON v.scope_policy_id = p.id AND v.version = p.current_version');
    expect(params).toEqual(['tenant-1']);
    expect(record).toEqual({
      id: 'sp-1',
      tenantId: 'tenant-1',
      name: 'Scope',
      description: 'desc',
      kind: 'builtin',
      managementMode: 'system_managed',
      status: 'archived',
      currentVersion: 3,
      definition: { tenantIds: ['tenant-1'] },
      definitionDigest: 'sd-1',
      selectorCatalogVersion: 'sel-1',
      createdAt: 11,
      updatedAt: 21,
    });
    await repo.listScopePolicies('tenant-1', { includeSystemManaged: true });
    expect(flat(query.mock.calls[1][0])).toContain('WHERE p.tenant_id = ? ORDER BY');
  });

  it('getScopePolicy includes system-managed policies and maps a null description', async () => {
    const { repo, query } = setup();
    query.mockResolvedValue([scopeRow({ id: 'sp-0' }), scopeRow({ description: null })]);
    await expect(repo.getScopePolicy('tenant-1', 'sp-1')).resolves.toMatchObject({
      id: 'sp-1',
      description: undefined,
    });
    expect(flat(query.mock.calls[0][0])).not.toContain("management_mode = 'managed'");
    await expect(repo.getScopePolicy('tenant-1', 'nope')).resolves.toBeNull();
  });

  it('getScopePolicyVersion reads an active version', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce(scopeRow());
    await expect(repo.getScopePolicyVersion('tenant-1', 'sp-1', 1)).resolves.toMatchObject({
      id: 'sp-1',
      currentVersion: 1,
    });
    const [sql, params] = queryOne.mock.calls[0];
    expect(flat(sql)).toContain(
      "WHERE p.tenant_id = ? AND p.id = ? AND v.version = ? AND v.status = 'active'"
    );
    expect(params).toEqual(['tenant-1', 'sp-1', 1]);
    await expect(repo.getScopePolicyVersion('tenant-1', 'sp-1', 2)).resolves.toBeNull();
  });

  it('createScopePolicyVersion advances under CAS with a guarded audit', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite({ id: 'audit-9' });
    const input = {
      tenantId: 'tenant-1',
      id: 'sp-1',
      expectedVersion: 1,
      definition,
      definitionDigest: 'sd-2',
      selectorCatalogVersion: 'sel-2',
      createdBy: 'admin-1',
      now: 77,
      audit,
    };
    await expect(repo.createScopePolicyVersion(input)).resolves.toBe(true);
    const [update, insert] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_scope_policies SET current_version = ?, last_transition_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'active' AND current_version = ?"
    );
    expect(update.params).toEqual([2, 'audit-9', 77, 'tenant-1', 'sp-1', 1]);
    expect(flat(insert.sql)).toContain(
      "SELECT id, ?, ?, ?, ?, 'active', ?, ? FROM agent_scope_policies WHERE tenant_id = ? AND id = ? AND last_transition_id = ?"
    );
    expect(insert.params).toEqual([
      2,
      '{"tenantIds":["tenant-1"]}',
      'sd-2',
      'sel-2',
      'admin-1',
      77,
      'tenant-1',
      'sp-1',
      'audit-9',
    ]);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_scope_policies',
      where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
      params: ['tenant-1', 'sp-1', 'audit-9'],
    });
    batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
    await expect(repo.createScopePolicyVersion(input)).resolves.toBe(false);
    batch.mockResolvedValueOnce([]);
    await expect(repo.createScopePolicyVersion(input)).resolves.toBe(false);
  });

  it('suspendScopePolicyVersion suspends an active tenant-owned version', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const input = { tenantId: 'tenant-1', id: 'sp-1', version: 3, audit };
    await expect(repo.suspendScopePolicyVersion(input)).resolves.toBe(true);
    const [update] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_scope_policy_versions SET status = 'suspended', last_transition_id = ? WHERE scope_policy_id = ? AND version = ? AND status = 'active' AND EXISTS (SELECT 1 FROM agent_scope_policies WHERE id = agent_scope_policy_versions.scope_policy_id AND tenant_id = ?)"
    );
    expect(update.params).toEqual(['audit-1', 'sp-1', 3, 'tenant-1']);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_scope_policy_versions v JOIN agent_scope_policies p ON p.id = v.scope_policy_id',
      where:
        'p.tenant_id = ? AND v.scope_policy_id = ? AND v.version = ? AND v.last_transition_id = ?',
      params: ['tenant-1', 'sp-1', 3, 'audit-1'],
    });
    batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
    await expect(repo.suspendScopePolicyVersion(input)).resolves.toBe(false);
    batch.mockResolvedValueOnce([]);
    await expect(repo.suspendScopePolicyVersion(input)).resolves.toBe(false);
  });
});
