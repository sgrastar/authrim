import { describe, expect, it } from 'vitest';
import type { CreateAdminAgentGrantWithPreauthorizationInput } from '../core/repositories/admin-agent-access-repository';
import { mutAudit, mutGrantRow, mutRepo } from './helpers/mut-adminrepo-adapter';
import { mutSelfServiceInput } from './helpers/mut-adminrepo-self-service';

async function preauthInput(): Promise<CreateAdminAgentGrantWithPreauthorizationInput> {
  const base = await mutSelfServiceInput();
  return {
    grant: {
      ...base.grant,
      delegationMode: 'admin_pre_authorized',
      machinePrincipalId: 'mp-1',
      purpose: undefined,
      managementMode: undefined,
    },
    delegationConsent: base.delegationConsent,
    oauthClientConsent: base.oauthClientConsent,
    audit: mutAudit('audit-grant'),
    consentAudit: mutAudit('audit-consent'),
  };
}

describe('createGrant statement', () => {
  it('binds every Grant column, including optional ones', async () => {
    const { grant } = await mutSelfServiceInput();
    const { adapter, repository } = mutRepo();
    await repository.createGrant({ ...grant, machinePrincipalId: 'mp-1' });
    expect(adapter.calls[0].params).toEqual([
      'grant-1',
      'tenant-1',
      'client-1',
      'mp-1',
      'admin-1',
      'admin-1',
      JSON.stringify(grant.permissions),
      JSON.stringify(grant.scopes),
      JSON.stringify(grant.authorizationDetails),
      JSON.stringify(grant.resolvedScopeConstraints),
      'interactive_self_service',
      'system_managed',
      'task-1',
      1,
      'policy-1',
      1,
      JSON.stringify(grant.resolvedTools),
      grant.accessSnapshotHash,
      'user_consent',
      1,
      1,
      'active',
      'active',
      700,
      100,
      100,
    ]);
  });

  it('defaults optional columns and keys a non-active Grant by its own ID', async () => {
    const { grant } = await mutSelfServiceInput();
    const { adapter, repository } = mutRepo();
    await repository.createGrant({
      ...grant,
      status: 'suspended',
      authorizationDetails: undefined,
      purpose: undefined,
      managementMode: undefined,
      expiresAt: undefined,
    });
    const params = adapter.calls[0].params ?? [];
    expect(params[3]).toBeNull();
    expect(params[8]).toBeNull();
    expect(params[10]).toBeNull();
    expect(params[11]).toBe('managed');
    expect(params.slice(21, 24)).toEqual(['suspended', 'grant-1', null]);
  });

  it('refuses a Grant without a complete configuration snapshot', async () => {
    const { grant } = await mutSelfServiceInput();
    const { adapter, repository } = mutRepo();
    await expect(repository.createGrant({ ...grant, taskSetId: undefined })).rejects.toThrow(
      new TypeError('Agent Grant requires a complete versioned configuration snapshot')
    );
    await expect(
      repository.createGrant({ ...grant, resolvedScopeConstraints: { tenantIds: ['tenant-2'] } })
    ).rejects.toThrow('Stored Agent scope constraints must identify only the Grant tenant');
    expect(adapter.calls).toHaveLength(0);
  });

  it('writes the Grant and its audit together', async () => {
    const { grant } = await mutSelfServiceInput();
    const { adapter, repository } = mutRepo();
    await repository.createGrantWithAudit({ grant, audit: mutAudit('audit-x') });
    expect(adapter.batches[0]).toHaveLength(2);
    expect(adapter.batches[0][1].params?.[0]).toBe('audit-x');
  });
});

describe('createGrantWithPreauthorization', () => {
  it('writes the Grant, both exact consents and both audits', async () => {
    const input = await preauthInput();
    const { adapter, repository } = mutRepo();
    await repository.createGrantWithPreauthorization(input);
    const batch = adapter.batches[0];
    expect(batch).toHaveLength(5);
    expect(batch[1].params?.at(-1)).toBe('audit-grant');
    expect(batch[2].params?.[2]).toBe('oauth_client');
    expect(batch[4].params?.[0]).toBe('audit-consent');
  });

  it.each<[string, (input: CreateAdminAgentGrantWithPreauthorizationInput) => void]>([
    ['the Grant is user-consented', (i) => void (i.grant.delegationMode = 'user_consent')],
    ['there is no machine principal', (i) => void (i.grant.machinePrincipalId = undefined)],
    [
      'the delegation consent type is wrong',
      (i) => void (i.delegationConsent.type = 'oauth_client'),
    ],
    [
      'the OAuth client consent type is wrong',
      (i) => void (i.oauthClientConsent.type = 'delegation'),
    ],
    ['the delegation consent Grant differs', (i) => void (i.delegationConsent.grantId = 'g2')],
    ['the OAuth client consent Grant differs', (i) => void (i.oauthClientConsent.grantId = 'g2')],
    ['the delegation consent user differs', (i) => void (i.delegationConsent.userId = 'u2')],
    ['the OAuth client consent user differs', (i) => void (i.oauthClientConsent.userId = 'u2')],
    ['the delegation consent client differs', (i) => void (i.delegationConsent.clientId = 'c2')],
    ['the OAuth client consent client differs', (i) => void (i.oauthClientConsent.clientId = 'c2')],
    [
      'the delegation consent version differs',
      (i) => void (i.delegationConsent.consentVersion = 7),
    ],
    [
      'the OAuth client consent version differs',
      (i) => void (i.oauthClientConsent.consentVersion = 7),
    ],
  ])('rejects when %s', async (_name, mutate) => {
    const input = await preauthInput();
    mutate(input);
    const { adapter, repository } = mutRepo();
    await expect(repository.createGrantWithPreauthorization(input)).rejects.toThrow(
      new TypeError('Agent preauthorization must match one Mode B Grant')
    );
    expect(adapter.batches).toHaveLength(0);
  });
});

describe('listGrants and listGrantAudit', () => {
  it('filters by every optional field and clamps paging', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([mutGrantRow()]);
    adapter.queryOneResults.push({ total: 7 });
    const result = await repository.listGrants({
      tenantId: 'tenant-1',
      delegatorId: 'admin-2',
      machinePrincipalId: 'mp-1',
      status: 'active',
      limit: 500,
      offset: -3,
    });
    expect(result.total).toBe(7);
    expect(result.grants.map((g) => g.grantId)).toEqual(['grant-1']);
    const [rows, count] = adapter.calls;
    expect(rows.sql).toContain(
      'WHERE tenant_id = ? AND delegator_id = ? AND machine_principal_id = ? AND status = ?'
    );
    expect(rows.params).toEqual(['tenant-1', 'admin-2', 'mp-1', 'active', 100, 0]);
    expect(count.params).toEqual(['tenant-1', 'admin-2', 'mp-1', 'active']);
  });

  it('uses defaults without filters and reports zero when the count row is missing', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.listGrants({ tenantId: 'tenant-1' })).resolves.toEqual({
      grants: [],
      total: 0,
    });
    expect(adapter.calls[0].sql).toContain('FROM admin_agent_grants WHERE tenant_id = ?\n');
    expect(adapter.calls[0].params).toEqual(['tenant-1', 50, 0]);
    await repository.listGrants({ tenantId: 'tenant-1', limit: 0, offset: 5 });
    expect(adapter.calls[2].params).toEqual(['tenant-1', 1, 5]);
  });

  it('maps audit rows and clamps the audit limit', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([
      {
        id: 'a1',
        action: 'x',
        result: 'success',
        severity: 'info',
        actor_type: null,
        actor_sub: 'sub',
        metadata_json: '{"k":1}',
        created_at: 5,
      },
    ]);
    await expect(repository.listGrantAudit('tenant-1', 'grant-1', 1000)).resolves.toEqual([
      {
        id: 'a1',
        action: 'x',
        result: 'success',
        severity: 'info',
        actorType: undefined,
        actorSub: 'sub',
        metadata: { k: 1 },
        createdAt: 5,
      },
    ]);
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'grant-1', 200]);
    await repository.listGrantAudit('tenant-1', 'grant-1', -1);
    expect(adapter.calls[1].params).toEqual(['tenant-1', 'grant-1', 1]);
    await repository.listGrantAudit('tenant-1', 'grant-1');
    expect(adapter.calls[2].params).toEqual(['tenant-1', 'grant-1', 100]);
  });

  it.each(['[]', 'null', '"x"'])('fails closed on audit metadata %s', async (metadata) => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([{ id: 'a', metadata_json: metadata, created_at: 1 }]);
    await expect(repository.listGrantAudit('tenant-1', 'grant-1')).rejects.toThrow(
      new TypeError('Stored Agent JSON object is invalid')
    );
  });
});

describe('getSystemManagedTaskSetCatalogVersion', () => {
  it.each<[string, number]>([
    ['', 1],
    ['task-1', 0],
    ['task-1', 1.5],
  ])('returns null without a query for task set %j version %d', async (id, version) => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.getSystemManagedTaskSetCatalogVersion('tenant-1', id, version)
    ).resolves.toBeNull();
    expect(adapter.calls).toHaveLength(0);
  });

  it('returns null when no active version exists', async () => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.getSystemManagedTaskSetCatalogVersion('tenant-1', 'task-1', 1)
    ).resolves.toBeNull();
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'task-1', 1]);
  });
});
