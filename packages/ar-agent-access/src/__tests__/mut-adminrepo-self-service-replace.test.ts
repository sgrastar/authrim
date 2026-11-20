import { describe, expect, it } from 'vitest';
import { AgentAccessConflictError } from '../core/repositories';
import { mutRepo } from './helpers/mut-adminrepo-adapter';
import { mutReplaceInput, mutReplayRow } from './helpers/mut-adminrepo-self-service';

const payload = (ids: string[]) =>
  JSON.stringify({ family_ids: ids, family_jtis: ids.map((id) => `jti-${id}`), reason: 'r' });

describe('replaceSelfServiceAuthorization', () => {
  it('rejects a generation that does not advance by exactly one', async () => {
    const input = await mutReplaceInput();
    input.expectedGeneration = 0;
    const { adapter, repository } = mutRepo();
    await expect(repository.replaceSelfServiceAuthorization(input)).rejects.toThrow(
      new TypeError('Self-service replacement inputs are inconsistent')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('rejects an outbox ID that is not bound to the transition', async () => {
    const input = await mutReplaceInput();
    input.outboxId = 'outbox_other';
    const { adapter, repository } = mutRepo();
    await expect(repository.replaceSelfServiceAuthorization(input)).rejects.toThrow(
      new TypeError('Self-service replacement outbox must be transition-bound')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('runs the shared consistency check before writing', async () => {
    const input = await mutReplaceInput();
    input.grant.purpose = 'other';
    const { adapter, repository } = mutRepo();
    await expect(repository.replaceSelfServiceAuthorization(input)).rejects.toThrow(
      'Self-service authorization inputs are inconsistent'
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('applies a fresh replacement without a replay read and counts the queued families', async () => {
    const input = await mutReplaceInput();
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ payload: payload(['f1', 'f2']) });
    await expect(repository.replaceSelfServiceAuthorization(input)).resolves.toEqual({
      familyCount: 2,
    });
    const batch = adapter.batches[0];
    expect(batch).toHaveLength(11);
    expect(batch[0].sql).toContain('UPDATE admin_agent_grants SET');
    expect(batch[0].params?.[2]).toBe(JSON.stringify(input.grant.authorizationDetails));
    expect(batch[0].params?.slice(-5)).toEqual(['tenant-1', 'grant-1', 'client-1', 'admin-1', 1]);
    expect(batch[1].params?.slice(2, 4)).toEqual([
      'System-managed connection grant-1 v2',
      'Regenerated from the approved interactive Agent scope set.',
    ]);
    expect(batch[1].params?.slice(-3)).toEqual(['tenant-1', 'grant-1', 'transition-1']);
    expect(batch[3].params?.slice(2, 4)).toEqual([
      'System-managed connection grant-1 v2',
      'Regenerated masked single-tenant limits for interactive Agent consent.',
    ]);
    expect(batch[5].params?.slice(0, 3)).toEqual(['consent-d', 'tenant-1', 'delegation']);
    expect(batch[5].params?.slice(9)).toEqual([
      'transition-1',
      'tenant-1',
      'grant-1',
      'transition-1',
    ]);
    expect(batch[7].sql).toContain("SET status = 'revocation_pending'");
    expect(batch[7].params?.slice(0, 5)).toEqual([
      100,
      'outbox_transition-1',
      'tenant-1',
      'grant-1',
      1,
    ]);
    expect(batch[8].sql).toContain("'self_service_scope_changed'");
    expect(batch[8].params?.slice(0, 5)).toEqual([
      'outbox_transition-1',
      'tenant-1',
      'grant-1',
      1,
      'client-1',
    ]);
    expect(adapter.calls).toEqual([
      expect.objectContaining({
        kind: 'queryOne',
        params: ['outbox_transition-1', 'tenant-1', 'grant-1'],
      }),
    ]);
  });

  it('stores null authorization details when the Grant has none', async () => {
    const input = await mutReplaceInput();
    input.grant.authorizationDetails = undefined;
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ payload: payload([]) });
    await expect(repository.replaceSelfServiceAuthorization(input)).resolves.toEqual({
      familyCount: 0,
    });
    expect(adapter.batches[0][0].params?.[2]).toBeNull();
  });

  it('accepts an exact idempotent replay when the Grant CAS affects no row', async () => {
    const input = await mutReplaceInput();
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push(mutReplayRow(input), { payload: payload(['f1']) });
    await expect(repository.replaceSelfServiceAuthorization(input)).resolves.toEqual({
      familyCount: 1,
    });
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'grant-1', 'client-1', 'admin-1']);
    expect(adapter.calls[0].sql).toContain('FROM admin_agent_grants');
  });

  it('accepts an exact replay of a Grant without authorization details', async () => {
    const input = await mutReplaceInput();
    input.grant.authorizationDetails = undefined;
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push(mutReplayRow(input), { payload: payload([]) });
    await expect(repository.replaceSelfServiceAuthorization(input)).resolves.toEqual({
      familyCount: 0,
    });
  });

  it('fails closed when the Grant row disappeared', async () => {
    const input = await mutReplaceInput();
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    await expect(repository.replaceSelfServiceAuthorization(input)).rejects.toThrow(
      new AgentAccessConflictError('Self-service Agent Grant changed during consent')
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['machine principal', { machine_principal_id: 'mp-1' }],
    ['grantor', { grantor_id: 'admin-9' }],
    ['permissions', { permissions: '[]' }],
    ['scopes', { scopes: '["agent:write"]' }],
    ['authorization details', { authorization_details: null }],
    ['scope constraints', { resolved_scope_constraints: '{}' }],
    ['purpose', { purpose: null }],
    ['management mode', { management_mode: 'managed' }],
    ['task set', { task_set_id: 'task-9' }],
    ['task set version', { task_set_version: 9 }],
    ['scope policy', { scope_policy_id: 'policy-9' }],
    ['scope policy version', { scope_policy_version: 9 }],
    ['resolved tools', { resolved_tools: null }],
    ['access snapshot hash', { access_snapshot_hash: null }],
    ['generation', { generation: 3 }],
    ['consent version', { consent_version: 3 }],
    ['status', { status: 'suspended' }],
    ['delegation mode', { delegation_mode: 'admin_pre_authorized' }],
    ['expiry', { expires_at: null }],
    ['updated_at', { updated_at: 101 }],
    ['last mutation', { last_mutation_id: 'transition-other' }],
  ])('treats a replay row with a different %s as a conflict', async (_name, override) => {
    const input = await mutReplaceInput();
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push({ ...mutReplayRow(input), ...override }, { payload: payload([]) });
    await expect(repository.replaceSelfServiceAuthorization(input)).rejects.toThrow(
      AgentAccessConflictError
    );
  });

  it('fails closed when the transition-bound outbox row is missing', async () => {
    const input = await mutReplaceInput();
    const { repository } = mutRepo();
    await expect(repository.replaceSelfServiceAuthorization(input)).rejects.toThrow(
      new AgentAccessConflictError('Self-service revocation outbox is missing')
    );
  });

  it('rejects a stored outbox payload whose families and JTIs diverge', async () => {
    const input = await mutReplaceInput();
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({
      payload: JSON.stringify({ family_ids: ['f1'], family_jtis: [], reason: 'r' }),
    });
    await expect(repository.replaceSelfServiceAuthorization(input)).rejects.toThrow(
      'Stored Agent token revocation payload is invalid'
    );
  });
});
