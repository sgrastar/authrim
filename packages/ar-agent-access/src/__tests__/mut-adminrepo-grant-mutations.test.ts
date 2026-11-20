import { describe, expect, it } from 'vitest';
import { AgentAccessConflictError } from '../core/repositories';
import type {
  InvalidateAgentGrantInput,
  ResumeAdminAgentGrantInput,
  UpdateAdminAgentGrantInput,
} from '../core/repositories/admin-agent-access-repository';
import { mutAudit, mutRepo } from './helpers/mut-adminrepo-adapter';

const payload = (n: number) =>
  JSON.stringify({
    family_ids: Array.from({ length: n }, (_, i) => `f${i}`),
    family_jtis: Array.from({ length: n }, (_, i) => `j${i}`),
    reason: 'r',
  });
const grantAudit = (overrides = {}) =>
  mutAudit('audit-1', { resourceId: 'grant-1', metadata: { k: 'v' }, ...overrides });

const invalidate = (
  overrides: Partial<InvalidateAgentGrantInput> = {}
): InvalidateAgentGrantInput => ({
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  expectedGeneration: 4,
  status: 'revoked',
  reason: 'admin',
  outboxId: 'outbox-1',
  now: 500,
  audit: grantAudit(),
  ...overrides,
});

const auditMetadata = (statement: { params?: unknown[] }): unknown =>
  JSON.parse(String(statement.params?.[9]));

describe('invalidateGrantAndQueueTokenRevocation', () => {
  it.each([
    ['tenant', grantAudit({ tenantId: 'tenant-2' })],
    ['resource', grantAudit({ resourceId: 'grant-2' })],
    ['Grant', grantAudit({ grantId: 'grant-2' })],
  ])('rejects an audit for another %s', async (_name, audit) => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.invalidateGrantAndQueueTokenRevocation(invalidate({ audit }))
    ).rejects.toThrow(new TypeError('Agent Grant audit context does not match the mutation'));
    expect(adapter.batches).toHaveLength(0);
  });

  it('accepts an audit that already names the same Grant and records the generation step', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ payload: payload(3) });
    await expect(
      repository.invalidateGrantAndQueueTokenRevocation(
        invalidate({ audit: grantAudit({ grantId: 'grant-1' }) })
      )
    ).resolves.toEqual({ familyCount: 3, nextGeneration: 5 });
    const batch = adapter.batches[0];
    const audit = batch[batch.length - 1];
    expect(audit.params?.[18]).toBe('grant-1');
    expect(auditMetadata(audit)).toEqual({
      k: 'v',
      outbox_id: 'outbox-1',
      previous_generation: 4,
      next_generation: 5,
      reason: 'admin',
    });
    expect(adapter.calls).toEqual([
      expect.objectContaining({ params: ['outbox-1', 'tenant-1', 'grant-1', 4] }),
    ]);
  });

  it('accepts an exact replay at the next generation', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push({ last_mutation_id: 'outbox-1' }, { payload: payload(0) });
    await expect(repository.invalidateGrantAndQueueTokenRevocation(invalidate())).resolves.toEqual({
      familyCount: 0,
      nextGeneration: 5,
    });
    expect(adapter.calls[0].params).toEqual([
      'tenant-1',
      'grant-1',
      'client-1',
      'revoked',
      5,
      'outbox-1',
    ]);
  });

  it('fails closed when the Grant changed or the outbox is missing', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    await expect(repository.invalidateGrantAndQueueTokenRevocation(invalidate())).rejects.toThrow(
      new AgentAccessConflictError('Agent Grant changed before invalidation')
    );
    await expect(repository.invalidateGrantAndQueueTokenRevocation(invalidate())).rejects.toThrow(
      new AgentAccessConflictError('Agent Grant invalidation outbox was not persisted')
    );
  });
});

const update = (
  overrides: Partial<UpdateAdminAgentGrantInput> = {}
): UpdateAdminAgentGrantInput => ({
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  expectedGeneration: 4,
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  outboxId: 'outbox-1',
  now: 500,
  audit: grantAudit(),
  ...overrides,
});

describe('updateGrantAndQueueTokenRevocation', () => {
  it.each([
    ['tenant', grantAudit({ tenantId: 'tenant-2' })],
    ['resource', grantAudit({ resourceId: 'grant-2' })],
    ['Grant', grantAudit({ grantId: 'grant-2' })],
  ])('rejects an audit for another %s', async (_name, audit) => {
    const { adapter, repository } = mutRepo();
    await expect(repository.updateGrantAndQueueTokenRevocation(update({ audit }))).rejects.toThrow(
      new TypeError('Agent Grant audit context does not match the update')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('rejects constraints for another tenant before writing', async () => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.updateGrantAndQueueTokenRevocation(
        update({ resolvedScopeConstraints: { tenantIds: ['tenant-2'] } })
      )
    ).rejects.toThrow('Stored Agent scope constraints must identify only the Grant tenant');
    expect(adapter.batches).toHaveLength(0);
  });

  it('writes the new contract and returns the persisted generation and consent version', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ generation: 5, consent_version: 9 }, { payload: payload(2) });
    await expect(
      repository.updateGrantAndQueueTokenRevocation(
        update({
          authorizationDetails: [{ type: 'authrim_admin_agent' }],
          purpose: 'ops',
          expiresAt: 900,
          audit: grantAudit({ grantId: 'grant-1' }),
        })
      )
    ).resolves.toEqual({ familyCount: 2, nextGeneration: 5, nextConsentVersion: 9 });
    const batch = adapter.batches[0];
    expect(batch[0].params).toEqual([
      '["admin:users:read"]',
      '["agent:read"]',
      '[{"type":"authrim_admin_agent"}]',
      '{"tenantIds":["tenant-1"]}',
      'ops',
      900,
      500,
      'outbox-1',
      'tenant-1',
      'grant-1',
      'client-1',
      4,
    ]);
    expect(auditMetadata(batch[batch.length - 1])).toEqual({
      k: 'v',
      outbox_id: 'outbox-1',
      previous_generation: 4,
      next_generation: 5,
      reason: 'grant_updated',
    });
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'grant-1', 'outbox-1']);
    expect(adapter.calls[1].params).toEqual(['outbox-1', 'tenant-1', 'grant-1', 4]);
  });

  it('binds null optional fields', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ generation: 5, consent_version: 9 }, { payload: payload(0) });
    await repository.updateGrantAndQueueTokenRevocation(update());
    expect(adapter.batches[0][0].params?.slice(2, 6)).toEqual([
      null,
      '{"tenantIds":["tenant-1"]}',
      null,
      null,
    ]);
  });

  it('fails closed when the applied update or its outbox cannot be read back', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.updateGrantAndQueueTokenRevocation(update())).rejects.toThrow(
      new AgentAccessConflictError('Agent Grant update result is unavailable')
    );
    adapter.queryOneResults.push({ generation: 5, consent_version: 9 });
    await expect(repository.updateGrantAndQueueTokenRevocation(update())).rejects.toThrow(
      new AgentAccessConflictError('Agent Grant update outbox was not persisted')
    );
  });

  it('returns the replayed generation for an exact retry', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push(
      { last_mutation_id: 'outbox-1', generation: 5, consent_version: 7 },
      { payload: payload(1) }
    );
    await expect(repository.updateGrantAndQueueTokenRevocation(update())).resolves.toEqual({
      familyCount: 1,
      nextGeneration: 5,
      nextConsentVersion: 7,
    });
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'grant-1', 'client-1', 5, 'outbox-1']);
    expect(adapter.calls[1].params).toEqual(['outbox-1', 'tenant-1', 'grant-1', 4]);
  });

  it('fails closed on a changed Grant or a missing replay outbox', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0], [0]);
    await expect(repository.updateGrantAndQueueTokenRevocation(update())).rejects.toThrow(
      new AgentAccessConflictError('Agent Grant changed before update')
    );
    adapter.queryOneResults.push({
      last_mutation_id: 'outbox-1',
      generation: 5,
      consent_version: 7,
    });
    await expect(repository.updateGrantAndQueueTokenRevocation(update())).rejects.toThrow(
      new AgentAccessConflictError('Agent Grant update outbox was not persisted')
    );
  });
});

const resume = (
  overrides: Partial<ResumeAdminAgentGrantInput> = {}
): ResumeAdminAgentGrantInput => ({
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  expectedGeneration: 4,
  transitionId: 'audit-1',
  expiresAt: 900,
  now: 500,
  audit: grantAudit(),
  ...overrides,
});

describe('resumeGrantWithAudit', () => {
  it.each([
    ['ID', grantAudit({ id: 'audit-2' })],
    ['tenant', grantAudit({ tenantId: 'tenant-2' })],
    ['resource', grantAudit({ resourceId: 'grant-2' })],
  ])('rejects an audit with another %s', async (_name, audit) => {
    const { adapter, repository } = mutRepo();
    await expect(repository.resumeGrantWithAudit(resume({ audit }))).rejects.toThrow(
      new TypeError('Agent Grant resume audit context does not match the transition')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('resumes a suspended Grant without a replay read', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.resumeGrantWithAudit(resume())).resolves.toBe(true);
    expect(adapter.batches[0][0].params).toEqual([
      900,
      500,
      'audit-1',
      'tenant-1',
      'grant-1',
      'client-1',
      4,
    ]);
    expect(adapter.batches[0][1].params?.[18]).toBe('grant-1');
    expect(adapter.calls).toHaveLength(0);
  });

  it('accepts only an exact replay after a lost CAS', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0], [0]);
    await expect(repository.resumeGrantWithAudit(resume())).resolves.toBe(false);
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'grant-1', 'client-1', 4, 'audit-1']);
    adapter.queryOneResults.push({ last_mutation_id: 'audit-1' });
    await expect(repository.resumeGrantWithAudit(resume())).resolves.toBe(true);
  });
});
