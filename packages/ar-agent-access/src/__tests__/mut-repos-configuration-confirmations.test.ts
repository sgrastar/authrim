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

const confirmationRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'conf-1',
  tenant_id: 'tenant-1',
  plan_id: 'plan-1',
  plan_version: 2,
  plan_digest: 'pd-1',
  grant_id: 'grant-1',
  actor_sub: 'agent:sub',
  confirmed_by: null,
  status: 'pending',
  expires_at: 99,
  ...overrides,
});

const secretRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'asr-1',
  tenant_id: 'tenant-1',
  resource_type: 'oidc_client',
  resource_id: 'client-1',
  purpose: 'auth',
  provider_key: 'pk-1',
  status: 'active',
  created_by: 'admin-1',
  created_at: 5,
  expires_at: 50,
  revoked_at: 40,
  revoked_by: 'admin-2',
  ...overrides,
});

describe('AgentConfigurationRepository plan confirmations', () => {
  const ensureInput = {
    id: 'conf-1',
    tenantId: 'tenant-1',
    planId: 'plan-1',
    planVersion: 2,
    planDigest: 'pd-1',
    grantId: 'grant-1',
    actorSub: 'agent:sub',
    now: 10,
    expiresAt: 99,
    audit: auditWrite(),
  };

  it('ensurePlanConfirmation inserts idempotently and returns the stored record', async () => {
    const { repo, batch, queryOne, writer, adapter } = setup();
    queryOne.mockResolvedValueOnce(confirmationRow());
    await expect(repo.ensurePlanConfirmation(ensureInput)).resolves.toEqual({
      id: 'conf-1',
      tenantId: 'tenant-1',
      planId: 'plan-1',
      planVersion: 2,
      planDigest: 'pd-1',
      grantId: 'grant-1',
      actorSub: 'agent:sub',
      confirmedBy: undefined,
      status: 'pending',
      expiresAt: 99,
    });
    const [insert, audit] = batchStatements(batch);
    expect(flat(insert.sql)).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)");
    expect(flat(insert.sql)).toContain(
      'ON CONFLICT(plan_id, plan_version, plan_digest) DO NOTHING'
    );
    expect(insert.params).toEqual([
      'conf-1',
      'tenant-1',
      'plan-1',
      2,
      'pd-1',
      'grant-1',
      'agent:sub',
      10,
      99,
      'audit-1',
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, ensureInput.audit, {
      from: 'agent_plan_confirmations',
      where: 'id = ? AND tenant_id = ? AND last_transition_id = ?',
      params: ['conf-1', 'tenant-1', 'audit-1'],
    });
    const [sql, params] = queryOne.mock.calls[0];
    expect(flat(sql)).toContain(
      'WHERE tenant_id = ? AND plan_id = ? AND plan_version = ? AND plan_digest = ?'
    );
    expect(params).toEqual(['tenant-1', 'plan-1', 2, 'pd-1']);
  });

  it('ensurePlanConfirmation fails when the row cannot be read back', async () => {
    const { repo } = setup();
    await expect(repo.ensurePlanConfirmation(ensureInput)).rejects.toThrow(
      'Plan confirmation could not be created'
    );
  });

  it('getPlanConfirmation maps confirmed_by and returns null when absent', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce(
      confirmationRow({ confirmed_by: 'admin-1', status: 'confirmed' })
    );
    await expect(repo.getPlanConfirmation('tenant-1', 'plan-1', 2, 'pd-1')).resolves.toMatchObject({
      confirmedBy: 'admin-1',
      status: 'confirmed',
    });
    await expect(repo.getPlanConfirmation('tenant-1', 'plan-1', 2, 'pd-1')).resolves.toBeNull();
  });

  it('confirmPlan confirms only an unexpired pending confirmation', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.confirmPlan({
        tenantId: 'tenant-1',
        confirmationId: 'conf-1',
        confirmedBy: 'admin-1',
        planId: 'plan-1',
        planVersion: 2,
        planDigest: 'pd-1',
        now: 10,
        audit,
      });
    await expect(run()).resolves.toBe(true);
    const [update, auditStatement] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_plan_confirmations SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, last_transition_id = ? WHERE tenant_id = ? AND id = ? AND plan_id = ? AND plan_version = ? AND plan_digest = ? AND status = 'pending' AND expires_at > ?"
    );
    expect(update.params).toEqual([
      'admin-1',
      10,
      'audit-1',
      'tenant-1',
      'conf-1',
      'plan-1',
      2,
      'pd-1',
      10,
    ]);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_plan_confirmations',
      where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
      params: ['tenant-1', 'conf-1', 'audit-1'],
    });
    batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
    await expect(run()).resolves.toBe(false);
    batch.mockResolvedValueOnce([]);
    await expect(run()).resolves.toBe(false);
  });
});

describe('AgentConfigurationRepository secret references', () => {
  it('createSecretRef inserts an active reference with nullable fields', async () => {
    const { repo, batch, writer } = setup();
    const base = {
      id: 'asr-1',
      tenantId: 'tenant-1',
      resourceType: 'oidc_client',
      purpose: 'auth',
      providerKey: 'pk-1',
      createdBy: 'admin-1',
      now: 5,
      audit: auditWrite(),
    };
    await repo.createSecretRef(base);
    const [insert, audit] = batchStatements(batch);
    expect(flat(insert.sql)).toContain('INSERT INTO agent_secret_refs');
    expect(flat(insert.sql)).toContain("VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)");
    expect(insert.params).toEqual([
      'asr-1',
      'tenant-1',
      'oidc_client',
      null,
      'auth',
      'pk-1',
      'admin-1',
      5,
      null,
    ]);
    expect(audit).toBe(AUDIT_STATEMENT);
    expect(writer.mock.calls[0][2]).toBeUndefined();

    await repo.createSecretRef({ ...base, resourceId: 'client-1', expiresAt: 50 });
    const params = batchStatements(batch, 1)[0].params!;
    expect(params[3]).toBe('client-1');
    expect(params[8]).toBe(50);
  });

  it('listSecretRefs maps rows and never exposes the provider key', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([
      secretRow(),
      secretRow({
        id: 'asr-2',
        resource_id: null,
        expires_at: null,
        revoked_at: null,
        revoked_by: null,
      }),
    ]);
    const rows = await repo.listSecretRefs('tenant-1', 7);
    expect(rows[0]).toEqual({
      id: 'asr-1',
      tenantId: 'tenant-1',
      resourceType: 'oidc_client',
      resourceId: 'client-1',
      purpose: 'auth',
      status: 'active',
      createdBy: 'admin-1',
      createdAt: 5,
      expiresAt: 50,
      revokedAt: 40,
      revokedBy: 'admin-2',
    });
    expect(rows[1]).toMatchObject({
      id: 'asr-2',
      resourceId: undefined,
      expiresAt: undefined,
      revokedAt: undefined,
      revokedBy: undefined,
    });
    expect(flat(query.mock.calls[0][0])).toContain(
      "CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? THEN 'expired' ELSE status END AS status"
    );
    expect(flat(query.mock.calls[0][0])).toContain(
      'FROM agent_secret_refs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC'
    );
  });

  it('resolveActiveSecretRef maps the full record including provider key', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([secretRow()]);
    await expect(
      repo.resolveActiveSecretRef({
        tenantId: 'tenant-1',
        id: 'asr-1',
        resourceType: 'oidc_client',
        purpose: 'auth',
        now: 7,
      })
    ).resolves.toEqual({
      id: 'asr-1',
      tenantId: 'tenant-1',
      resourceType: 'oidc_client',
      resourceId: 'client-1',
      purpose: 'auth',
      providerKey: 'pk-1',
      status: 'active',
      createdBy: 'admin-1',
      createdAt: 5,
      expiresAt: 50,
      revokedAt: 40,
      revokedBy: 'admin-2',
    });
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain(
      "AND COALESCE(resource_id, '') = COALESCE(?, '') AND purpose = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) LIMIT 1"
    );
    expect(params).toEqual(['tenant-1', 'asr-1', 'oidc_client', null, 'auth', 7]);
  });

  it('resolveActiveSecretRef maps null columns and returns null when nothing matches', async () => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([
      secretRow({ resource_id: null, expires_at: null, revoked_at: null, revoked_by: null }),
    ]);
    const input = {
      tenantId: 'tenant-1',
      id: 'asr-1',
      resourceType: 'oidc_client',
      purpose: 'auth',
      now: 7,
    };
    await expect(repo.resolveActiveSecretRef(input)).resolves.toMatchObject({
      resourceId: undefined,
      expiresAt: undefined,
      revokedAt: undefined,
      revokedBy: undefined,
    });
    await expect(repo.resolveActiveSecretRef(input)).resolves.toBeNull();
  });

  it('revokeSecretRef revokes only active references with a guarded audit', async () => {
    const { repo, batch, writer, adapter } = setup();
    const audit = auditWrite();
    const run = () =>
      repo.revokeSecretRef({
        tenantId: 'tenant-1',
        id: 'asr-1',
        revokedBy: 'admin-1',
        now: 9,
        audit,
      });
    await expect(run()).resolves.toBe(true);
    const [update, auditStatement] = batchStatements(batch);
    expect(flat(update.sql)).toBe(
      "UPDATE agent_secret_refs SET status = 'revoked', revoked_at = ?, revoked_by = ?, last_transition_id = ? WHERE tenant_id = ? AND id = ? AND status = 'active'"
    );
    expect(update.params).toEqual([9, 'admin-1', 'audit-1', 'tenant-1', 'asr-1']);
    expect(auditStatement).toBe(AUDIT_STATEMENT);
    expect(writer).toHaveBeenCalledWith(adapter, audit, {
      from: 'agent_secret_refs',
      where: 'tenant_id = ? AND id = ? AND last_transition_id = ?',
      params: ['tenant-1', 'asr-1', 'audit-1'],
    });
    batch.mockResolvedValueOnce([{ rowsAffected: 0, success: true }]);
    await expect(run()).resolves.toBe(false);
    batch.mockResolvedValueOnce([]);
    await expect(run()).resolves.toBe(false);
  });
});
