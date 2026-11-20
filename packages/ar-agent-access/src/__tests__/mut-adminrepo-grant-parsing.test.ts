import { describe, expect, it } from 'vitest';
import { mutGrantRow, mutRepo } from './helpers/mut-adminrepo-adapter';

async function readGrant(overrides: Record<string, unknown>) {
  const { adapter, repository } = mutRepo();
  adapter.queryOneResults.push(mutGrantRow(overrides));
  return repository.getGrant('tenant-1', 'grant-1');
}

const constraints = (value: unknown) => ({ resolved_scope_constraints: JSON.stringify(value) });

describe('stored Grant parsing', () => {
  it('maps every stored column of a fully configured Grant', async () => {
    const tools = [{ toolId: 't' }];
    await expect(
      readGrant({
        machine_principal_id: 'mp-1',
        scopes: '["agent:read","agent:user-data:read","agent:write","agent:execute","agent:admin"]',
        authorization_details: '[{"type":"authrim_admin_agent"}]',
        task_set_id: 'task-1',
        task_set_version: 2,
        scope_policy_id: 'policy-1',
        scope_policy_version: 3,
        resolved_tools: JSON.stringify(tools),
        access_snapshot_hash: 'hash',
        expires_at: 999,
        ...constraints({
          tenantIds: ['tenant-1'],
          environmentIds: ['env-1'],
          domains: ['d.example'],
          allowedFields: [],
          resourceSelector: { kind: 'ids', ids: ['u1'] },
          piiMode: 'unmasked',
          maxPerCall: 1,
          maxPerPlan: 2,
          maxPerBulkPlan: 3,
        }),
      })
    ).resolves.toEqual({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      machinePrincipalId: 'mp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-2',
      permissions: ['admin:users:read'],
      scopes: ['agent:read', 'agent:user-data:read', 'agent:write', 'agent:execute', 'agent:admin'],
      authorizationDetails: [{ type: 'authrim_admin_agent' }],
      resolvedScopeConstraints: {
        tenantIds: ['tenant-1'],
        environmentIds: ['env-1'],
        domains: ['d.example'],
        allowedFields: [],
        resourceSelector: { kind: 'ids', ids: ['u1'] },
        piiMode: 'unmasked',
        maxPerCall: 1,
        maxPerPlan: 2,
        maxPerBulkPlan: 3,
      },
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'task-1',
      taskSetVersion: 2,
      scopePolicyId: 'policy-1',
      scopePolicyVersion: 3,
      resolvedTools: tools,
      accessSnapshotHash: 'hash',
      expiresAt: 999,
    });
  });

  it('omits every optional constraint that is not stored', async () => {
    const grant = await readGrant({});
    expect(grant?.resolvedScopeConstraints).toStrictEqual({ tenantIds: ['tenant-1'] });
    expect(grant?.authorizationDetails).toBeUndefined();
    expect(grant?.machinePrincipalId).toBeUndefined();
    expect(grant?.resolvedTools).toBeUndefined();
  });

  it('keeps a masked catalog selector', async () => {
    const grant = await readGrant(
      constraints({
        tenantIds: ['tenant-1'],
        piiMode: 'masked',
        resourceSelector: { kind: 'catalog', selectorId: 'sel-1', version: 1 },
      })
    );
    expect(grant?.resolvedScopeConstraints).toStrictEqual({
      tenantIds: ['tenant-1'],
      piiMode: 'masked',
      resourceSelector: { kind: 'catalog', selectorId: 'sel-1', version: 1 },
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'a non-array permission list',
      { permissions: '{"a":1}' },
      'Stored Agent access array is invalid',
    ],
    ['a non-string permission', { permissions: '[1]' }, 'Stored Agent access array is invalid'],
    ['an unknown scope', { scopes: '["agent:root"]' }, 'Stored Agent scope is invalid'],
    [
      'object authorization details',
      { authorization_details: '{}' },
      'Stored Agent authorization details are invalid',
    ],
    [
      'a null authorization detail',
      { authorization_details: '[null]' },
      'Stored Agent authorization details are invalid',
    ],
    [
      'a scalar authorization detail',
      { authorization_details: '[1]' },
      'Stored Agent authorization details are invalid',
    ],
    [
      'an array authorization detail',
      { authorization_details: '[[]]' },
      'Stored Agent authorization details are invalid',
    ],
    ['null constraints', constraints(null), 'Stored Agent scope constraints are invalid'],
    ['array constraints', constraints([]), 'Stored Agent scope constraints are invalid'],
    ['scalar constraints', constraints('x'), 'Stored Agent scope constraints are invalid'],
    [
      'an unknown constraint',
      constraints({ tenantIds: ['tenant-1'], extra: 1 }),
      'Stored Agent scope constraints contain an unknown field',
    ],
    [
      'missing tenant IDs',
      constraints({}),
      'Stored Agent scope constraints must identify only the Grant tenant',
    ],
    [
      'empty tenant IDs',
      constraints({ tenantIds: [] }),
      'Stored Agent scope constraint tenantIds is invalid',
    ],
    [
      'a non-array tenant list',
      constraints({ tenantIds: 'tenant-1' }),
      'Stored Agent scope constraint tenantIds is invalid',
    ],
    [
      'an empty tenant ID',
      constraints({ tenantIds: [''] }),
      'Stored Agent scope constraint tenantIds is invalid',
    ],
    [
      'a numeric tenant ID',
      constraints({ tenantIds: [1] }),
      'Stored Agent scope constraint tenantIds is invalid',
    ],
    [
      'two tenants',
      constraints({ tenantIds: ['tenant-1', 'tenant-2'] }),
      'Stored Agent scope constraints must identify only the Grant tenant',
    ],
    [
      'another tenant',
      constraints({ tenantIds: ['tenant-2'] }),
      'Stored Agent scope constraints must identify only the Grant tenant',
    ],
    [
      'an empty environment ID',
      constraints({ tenantIds: ['tenant-1'], environmentIds: [''] }),
      'Stored Agent scope constraint environmentIds is invalid',
    ],
    [
      'a non-string domain',
      constraints({ tenantIds: ['tenant-1'], domains: [1] }),
      'Stored Agent scope constraint domains is invalid',
    ],
    [
      'a non-array allowed field list',
      constraints({ tenantIds: ['tenant-1'], allowedFields: 'email' }),
      'Stored Agent scope constraint allowedFields is invalid',
    ],
    [
      'a null selector',
      constraints({ tenantIds: ['tenant-1'], resourceSelector: null }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'a string selector',
      constraints({ tenantIds: ['tenant-1'], resourceSelector: 'ids' }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'an array selector',
      constraints({ tenantIds: ['tenant-1'], resourceSelector: [] }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'an empty ID selector',
      constraints({ tenantIds: ['tenant-1'], resourceSelector: { kind: 'ids', ids: [] } }),
      'Stored Agent scope constraint resourceSelector.ids is invalid',
    ],
    [
      'an ID selector with extra fields',
      constraints({
        tenantIds: ['tenant-1'],
        resourceSelector: { kind: 'ids', ids: ['u'], extra: 1 },
      }),
      'Stored Agent resource selector contains an unknown field',
    ],
    [
      'an unknown selector kind',
      constraints({ tenantIds: ['tenant-1'], resourceSelector: { kind: 'query' } }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'a catalog selector without ID',
      constraints({ tenantIds: ['tenant-1'], resourceSelector: { kind: 'catalog', version: 1 } }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'a catalog selector with an empty ID',
      constraints({
        tenantIds: ['tenant-1'],
        resourceSelector: { kind: 'catalog', selectorId: '', version: 1 },
      }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'a catalog selector at version 0',
      constraints({
        tenantIds: ['tenant-1'],
        resourceSelector: { kind: 'catalog', selectorId: 's', version: 0 },
      }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'a fractional catalog version',
      constraints({
        tenantIds: ['tenant-1'],
        resourceSelector: { kind: 'catalog', selectorId: 's', version: 1.5 },
      }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'a catalog selector with extra fields',
      constraints({
        tenantIds: ['tenant-1'],
        resourceSelector: { kind: 'catalog', selectorId: 's', version: 1, ids: [] },
      }),
      'Stored Agent resource selector is invalid',
    ],
    [
      'an unknown PII mode',
      constraints({ tenantIds: ['tenant-1'], piiMode: 'raw' }),
      'Stored Agent scope constraint piiMode is invalid',
    ],
    [
      'a zero per-call limit',
      constraints({ tenantIds: ['tenant-1'], maxPerCall: 0 }),
      'Stored Agent scope constraint maxPerCall is invalid',
    ],
    [
      'a fractional per-plan limit',
      constraints({ tenantIds: ['tenant-1'], maxPerPlan: 1.5 }),
      'Stored Agent scope constraint maxPerPlan is invalid',
    ],
    [
      'a string bulk limit',
      constraints({ tenantIds: ['tenant-1'], maxPerBulkPlan: '2' }),
      'Stored Agent scope constraint maxPerBulkPlan is invalid',
    ],
  ])('fails closed on %s', async (_name, overrides, message) => {
    await expect(readGrant(overrides)).rejects.toThrow(new TypeError(message));
  });

  it('accepts a catalog selector at version 1 and an ID selector with one ID', async () => {
    await expect(
      readGrant(
        constraints({
          tenantIds: ['tenant-1'],
          resourceSelector: { kind: 'catalog', selectorId: 's', version: 1 },
        })
      )
    ).resolves.toBeTruthy();
    await expect(
      readGrant(
        constraints({ tenantIds: ['tenant-1'], resourceSelector: { kind: 'ids', ids: ['u'] } })
      )
    ).resolves.toBeTruthy();
  });

  it('returns null for a missing Grant and queries by tenant and ID', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.getGrant('tenant-1', 'grant-x')).resolves.toBeNull();
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'grant-x']);
    await expect(repository.getGrantRecord('tenant-1', 'grant-x')).resolves.toBeNull();
    await expect(
      repository.findActiveGrantForDelegatorClient('tenant-1', 'admin-2', 'client-1')
    ).resolves.toBeNull();
  });

  it('maps the management record fields', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(
      mutGrantRow({
        authorization_details: '[{"type":"x"}]',
        purpose: 'p',
        management_mode: 'system_managed',
        last_used_at: 30,
        revoked_at: 40,
        revoked_by: 'admin-9',
      })
    );
    await expect(repository.getGrantRecord('tenant-1', 'grant-1')).resolves.toMatchObject({
      authorizationDetails: [{ type: 'x' }],
      purpose: 'p',
      managementMode: 'system_managed',
      lastUsedAt: 30,
      createdAt: 10,
      updatedAt: 20,
      revokedAt: 40,
      revokedBy: 'admin-9',
    });
    adapter.queryOneResults.push(mutGrantRow());
    const minimal = await repository.getGrantRecord('tenant-1', 'grant-1');
    expect(minimal).toMatchObject({ managementMode: 'managed' });
    expect(minimal?.purpose).toBeUndefined();
    expect(minimal?.lastUsedAt).toBeUndefined();
    expect(minimal?.revokedAt).toBeUndefined();
    expect(minimal?.revokedBy).toBeUndefined();
  });
});
