import { describe, expect, it } from 'vitest';
import type { CreateSelfServiceAgentAuthorizationInput } from '../core/repositories/admin-agent-access-repository';
import { mutRepo } from './helpers/mut-adminrepo-adapter';
import { mutSelfServiceInput } from './helpers/mut-adminrepo-self-service';

type Input = CreateSelfServiceAgentAuthorizationInput;
type Mutation = [string, (input: Input) => void];

const INCONSISTENT = 'Self-service authorization inputs are inconsistent';

const inconsistentCases: Mutation[] = [
  [
    'delegation mode is not user consent',
    (i) => void (i.grant.delegationMode = 'admin_pre_authorized'),
  ],
  ['purpose is not interactive self-service', (i) => void (i.grant.purpose = 'other')],
  ['management mode is managed', (i) => void (i.grant.managementMode = 'managed')],
  ['a machine principal is present', (i) => void (i.grant.machinePrincipalId = 'mp-1')],
  ['grantor differs from delegator', (i) => void (i.grant.grantorId = 'admin-9')],
  ['expiry is missing', (i) => void (i.grant.expiresAt = undefined)],
  ['expiry is not a safe integer', (i) => void (i.grant.expiresAt = 700.5)],
  ['expiry equals creation', (i) => void (i.grant.expiresAt = i.grant.createdAt)],
  ['task set ID differs', (i) => void (i.taskSet.id = 'task-other')],
  ['task set version differs', (i) => void (i.taskSet.version = 2)],
  ['scope policy ID differs', (i) => void (i.scopePolicy.id = 'policy-other')],
  ['scope policy version differs', (i) => void (i.scopePolicy.version = 2)],
  ['task set digest differs from resolved digest', (i) => void (i.taskSet.resolved.digest = 'x')],
  [
    'delegation consent has the wrong type',
    (i) => void (i.delegationConsent.type = 'oauth_client'),
  ],
  [
    'OAuth client consent has the wrong type',
    (i) => void (i.oauthClientConsent.type = 'delegation'),
  ],
  ['delegation consent tenant differs', (i) => void (i.delegationConsent.tenantId = 'tenant-2')],
  ['OAuth client consent tenant differs', (i) => void (i.oauthClientConsent.tenantId = 'tenant-2')],
  ['delegation consent Grant differs', (i) => void (i.delegationConsent.grantId = 'grant-2')],
  ['OAuth client consent Grant differs', (i) => void (i.oauthClientConsent.grantId = 'grant-2')],
  ['delegation consent user differs', (i) => void (i.delegationConsent.userId = 'admin-2')],
  ['OAuth client consent user differs', (i) => void (i.oauthClientConsent.userId = 'admin-2')],
  ['delegation consent client differs', (i) => void (i.delegationConsent.clientId = 'client-2')],
  ['OAuth client consent client differs', (i) => void (i.oauthClientConsent.clientId = 'client-2')],
  ['delegation consent version differs', (i) => void (i.delegationConsent.consentVersion = 9)],
  ['OAuth client consent version differs', (i) => void (i.oauthClientConsent.consentVersion = 9)],
  ['delegation consent scopes differ', (i) => void (i.delegationConsent.scopes = ['agent:write'])],
  [
    'OAuth client consent scopes differ',
    (i) => void (i.oauthClientConsent.scopes = ['agent:write']),
  ],
  [
    'resolved permissions differ',
    (i) => void (i.taskSet.resolved.permissions = ['admin:users:read']),
  ],
  ['resolved tools differ', (i) => void (i.taskSet.resolved.tools = [])],
  [
    'policy covers another tenant',
    (i) =>
      void (i.scopePolicy.definition = { ...i.scopePolicy.definition, tenantIds: ['tenant-2'] }),
  ],
  [
    'policy is unmasked',
    (i) =>
      void (i.scopePolicy.definition = {
        ...i.scopePolicy.definition,
        piiMode: 'explicit_unmasked',
      }),
  ],
  [
    'Grant constraints are unmasked',
    (i) => void (i.grant.resolvedScopeConstraints.piiMode = 'unmasked'),
  ],
  [
    'Grant per-call limit differs from policy',
    (i) => void (i.grant.resolvedScopeConstraints.maxPerCall = 49),
  ],
  [
    'Grant per-plan limit differs from policy',
    (i) => void (i.grant.resolvedScopeConstraints.maxPerPlan = 24),
  ],
  [
    'Grant bulk limit differs from policy',
    (i) => void (i.grant.resolvedScopeConstraints.maxPerBulkPlan = 2),
  ],
];

async function expectRejected(input: Input, message: string) {
  const { adapter, repository } = mutRepo();
  await expect(repository.createSelfServiceAuthorization(input)).rejects.toThrow(
    new TypeError(message)
  );
  expect(adapter.batches).toHaveLength(0);
  expect(adapter.calls).toHaveLength(0);
}

describe('self-service authorization consistency (createSelfServiceAuthorization)', () => {
  it('accepts the consistent baseline and writes the full control plane in one batch', async () => {
    const input = await mutSelfServiceInput();
    const { adapter, repository } = mutRepo();
    await repository.createSelfServiceAuthorization(input);
    expect(adapter.batches).toHaveLength(1);
    const [taskSet, taskVersion, policy, policyVersion, grant, d, o, a1, a2] = adapter.batches[0];
    expect(adapter.batches[0]).toHaveLength(9);
    expect(taskSet.sql).toContain('INSERT INTO agent_task_sets');
    expect(taskSet.params).toEqual([
      'task-1',
      'tenant-1',
      'System-managed connection grant-1',
      'Generated from scopes approved during interactive Agent consent.',
      1,
      'admin-1',
      'audit-create',
      100,
      100,
    ]);
    expect(taskVersion.sql).toContain('INSERT INTO agent_task_set_versions');
    expect(policy.sql).toContain('INSERT INTO agent_scope_policies');
    expect(policy.params?.slice(2, 4)).toEqual([
      'System-managed connection grant-1',
      'Generated masked, single-tenant limits approved during interactive Agent consent.',
    ]);
    expect(policyVersion.sql).toContain('INSERT INTO agent_scope_policy_versions');
    expect(policyVersion.params?.[4]).toBe('selectors-v1');
    expect(grant.sql).toContain('INSERT INTO admin_agent_grants');
    expect(grant.params?.[10]).toBe('interactive_self_service');
    expect(grant.params?.[11]).toBe('system_managed');
    expect(d.params?.slice(0, 3)).toEqual(['consent-d', 'tenant-1', 'delegation']);
    expect(d.params?.at(-1)).toBe('audit-create');
    expect(o.params?.slice(0, 3)).toEqual(['consent-o', 'tenant-1', 'oauth_client']);
    expect(a1.params?.[0]).toBe('audit-create');
    expect(a2.params?.[0]).toBe('audit-consent');
  });

  it('accepts a Grant without authorization details at the default per-call ceiling', async () => {
    const input = await mutSelfServiceInput();
    input.grant.authorizationDetails = undefined;
    const { adapter, repository } = mutRepo();
    await repository.createSelfServiceAuthorization(input);
    expect(adapter.batches).toHaveLength(1);
    expect(adapter.batches[0][4].params?.[8]).toBeNull();
  });

  it.each(inconsistentCases)('rejects when %s', async (_name, mutate) => {
    const input = await mutSelfServiceInput();
    mutate(input);
    await expectRejected(input, INCONSISTENT);
  });

  it('rejects an incomplete configuration snapshot before any other check', async () => {
    const input = await mutSelfServiceInput();
    input.grant.resolvedTools = [];
    await expectRejected(
      input,
      'Self-service authorization requires a complete configuration snapshot'
    );
  });

  it('rejects Grant constraints that name another tenant', async () => {
    const input = await mutSelfServiceInput();
    input.grant.resolvedScopeConstraints.tenantIds = ['tenant-2'];
    await expectRejected(
      input,
      'Stored Agent scope constraints must identify only the Grant tenant'
    );
  });

  it('rejects authorization details whose ceiling differs from the Grant per-call limit', async () => {
    const input = await mutSelfServiceInput();
    input.grant.authorizationDetails = [{ type: 'authrim_admin_agent', max_subjects_per_call: 40 }];
    await expectRejected(input, 'Self-service authorization RAR constraints are inconsistent');
  });

  it('rejects a task set digest that does not hash the resolved catalog', async () => {
    const input = await mutSelfServiceInput();
    input.taskSet.digest = 'forged';
    input.taskSet.resolved.digest = 'forged';
    await expectRejected(input, 'Self-service authorization digest is invalid');
  });

  it('rejects a scope policy digest that does not hash the definition', async () => {
    const input = await mutSelfServiceInput();
    input.scopePolicy.digest = 'forged';
    await expectRejected(input, 'Self-service authorization digest is invalid');
  });

  it('rejects an access snapshot hash that does not bind the approved snapshot', async () => {
    const input = await mutSelfServiceInput();
    input.grant.accessSnapshotHash = 'B'.repeat(43);
    await expectRejected(input, 'Self-service authorization digest is invalid');
  });
});
