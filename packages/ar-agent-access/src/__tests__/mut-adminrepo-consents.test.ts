import { describe, expect, it } from 'vitest';
import { AgentAccessConflictError } from '../core/repositories';
import type {
  GrantAgentConsentPairInput,
  RevokeOauthClientConsentInput,
  UpsertAgentConsentInput,
} from '../core/repositories/admin-agent-access-repository';
import { mutAudit, mutRepo } from './helpers/mut-adminrepo-adapter';

const consent = (
  type: 'delegation' | 'oauth_client',
  id = `c-${type}`
): UpsertAgentConsentInput => ({
  id,
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  userId: 'admin-1',
  clientId: 'client-1',
  type,
  consentVersion: 2,
  scopes: ['agent:read'],
  grantedAt: 100,
});

const consentRow = (type: string, overrides: Record<string, unknown> = {}) => ({
  id: `c-${type}`,
  tenant_id: 'tenant-1',
  consent_type: type,
  grant_id: 'grant-1',
  user_id: 'admin-1',
  client_id: 'client-1',
  consent_version: 2,
  scopes: '["agent:read"]',
  granted_at: 100,
  revoked_at: null,
  revoked_reason: null,
  ...overrides,
});

const pair = (): GrantAgentConsentPairInput => ({
  delegation: consent('delegation'),
  oauthClient: consent('oauth_client'),
  audit: mutAudit('audit-pair', { metadata: { source: 'test' } }),
});

describe('consent writes', () => {
  it('upserts one consent with an unguarded VALUES insert', async () => {
    const { adapter, repository } = mutRepo();
    await repository.upsertConsent(consent('delegation'));
    expect(adapter.calls[0].sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)');
    expect(adapter.calls[0].params).toEqual([
      'c-delegation',
      'tenant-1',
      'delegation',
      'grant-1',
      'admin-1',
      'client-1',
      2,
      '["agent:read"]',
      100,
    ]);
  });

  it('records the previous consent versions and revocation state in the pair audit', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([
      { consent_type: 'delegation', consent_version: 1, revoked_at: 50 },
      { consent_type: 'oauth_client', consent_version: 1, revoked_at: null },
    ]);
    await repository.grantConsentPair(pair());
    expect(adapter.calls[0].params).toEqual(['grant-1', 'client-1']);
    expect(adapter.calls[0].sql).toContain("consent_type IN ('delegation', 'oauth_client')");
    const [d, o, audit] = adapter.batches[0];
    expect(d.params?.[2]).toBe('delegation');
    expect(o.params?.[2]).toBe('oauth_client');
    expect(JSON.parse(String(audit.params?.[9]))).toEqual({
      source: 'test',
      previous_delegation_version: 1,
      previous_delegation_revoked: true,
      previous_oauth_client_version: 1,
      previous_oauth_client_revoked: false,
    });
  });

  it('records a first-time pair with null previous versions', async () => {
    const { adapter, repository } = mutRepo();
    await repository.grantConsentPair(pair());
    expect(JSON.parse(String(adapter.batches[0][2].params?.[9]))).toMatchObject({
      previous_delegation_version: null,
      previous_delegation_revoked: false,
      previous_oauth_client_version: null,
      previous_oauth_client_revoked: false,
    });
  });

  it.each<[string, (input: GrantAgentConsentPairInput) => void]>([
    ['delegation type is wrong', (i) => void (i.delegation.type = 'oauth_client')],
    ['OAuth client type is wrong', (i) => void (i.oauthClient.type = 'delegation')],
    ['tenants differ', (i) => void (i.oauthClient.tenantId = 'tenant-2')],
    ['Grants differ', (i) => void (i.oauthClient.grantId = 'grant-2')],
    ['users differ', (i) => void (i.oauthClient.userId = 'admin-2')],
    ['clients differ', (i) => void (i.oauthClient.clientId = 'client-2')],
    ['versions differ', (i) => void (i.oauthClient.consentVersion = 3)],
  ])('rejects a consent pair whose %s', async (_name, mutate) => {
    const input = pair();
    mutate(input);
    const { adapter, repository } = mutRepo();
    await expect(repository.grantConsentPair(input)).rejects.toThrow(
      new TypeError('Agent consent pair must describe one Grant authorization')
    );
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('consent reads', () => {
  it('requires both current consent rows at the Grant consent version', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([consentRow('delegation'), consentRow('oauth_client')]);
    await expect(
      repository.hasCurrentConsent('tenant-1', 'grant-1', 'admin-1', 'client-1', 2)
    ).resolves.toBe(true);
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'grant-1', 'admin-1', 'client-1']);
    adapter.queryResults.push([
      consentRow('delegation'),
      consentRow('oauth_client', { revoked_at: 5, revoked_reason: 'user' }),
    ]);
    await expect(
      repository.hasCurrentConsent('tenant-1', 'grant-1', 'admin-1', 'client-1', 2)
    ).resolves.toBe(false);
  });

  it('lists a user consent history with Grant state', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([
      {
        ...consentRow('oauth_client', { revoked_at: 7, revoked_reason: 'user' }),
        grant_status: 'revoked',
        grant_generation: 4,
      },
    ]);
    await expect(repository.listUserConsents('tenant-1', 'admin-1')).resolves.toEqual([
      {
        id: 'c-oauth_client',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        userId: 'admin-1',
        clientId: 'client-1',
        type: 'oauth_client',
        consentVersion: 2,
        scopes: ['agent:read'],
        grantedAt: 100,
        revokedAt: 7,
        revokedReason: 'user',
        grantStatus: 'revoked',
        grantGeneration: 4,
      },
    ]);
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'admin-1']);
  });
});

const revokeInput = (
  overrides: Partial<RevokeOauthClientConsentInput> = {}
): RevokeOauthClientConsentInput => ({
  consentId: 'c-oauth_client',
  tenantId: 'tenant-1',
  userId: 'admin-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  grantGeneration: 3,
  outboxId: 'outbox-1',
  now: 500,
  audit: mutAudit('outbox-1', { resourceId: 'c-oauth_client' }),
  ...overrides,
});
const payload = (n: number) =>
  JSON.stringify({
    family_ids: Array.from({ length: n }, (_, i) => `f${i}`),
    family_jtis: Array.from({ length: n }, (_, i) => `j${i}`),
    reason: 'oauth_client_consent_revoked',
  });

describe('revokeOauthClientConsentAndQueueTokenRevocation', () => {
  it.each<[string, Partial<RevokeOauthClientConsentInput>]>([
    [
      'audit ID differs from outbox',
      { audit: mutAudit('other', { resourceId: 'c-oauth_client' }) },
    ],
    [
      'audit tenant differs',
      { audit: mutAudit('outbox-1', { tenantId: 'tenant-2', resourceId: 'c-oauth_client' }) },
    ],
    ['audit resource differs', { audit: mutAudit('outbox-1', { resourceId: 'other' }) }],
  ])('rejects when the %s', async (_name, overrides) => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(revokeInput(overrides))
    ).rejects.toThrow(
      new TypeError('OAuth client consent audit context does not match the revocation')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('revokes, queues the families and binds the Grant to the audit', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ payload: payload(2) });
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(revokeInput())
    ).resolves.toEqual({ familyCount: 2 });
    const [consentUpdate, families, outbox, audit] = adapter.batches[0];
    expect(consentUpdate.params).toEqual([
      500,
      'outbox-1',
      'c-oauth_client',
      'tenant-1',
      'admin-1',
      'grant-1',
      'client-1',
    ]);
    expect(families.params?.slice(2, 6)).toEqual(['tenant-1', 'grant-1', 3, 'client-1']);
    expect(outbox.sql).toContain("'oauth_client_consent_revoked'");
    expect(audit.params?.[18]).toBe('grant-1');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].params).toEqual(['outbox-1', 'tenant-1', 'grant-1']);
  });

  it('accepts a replay already revoked by the same outbox mutation', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push({ last_mutation_id: 'outbox-1' }, { payload: payload(0) });
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(revokeInput())
    ).resolves.toEqual({ familyCount: 0 });
    expect(adapter.calls[0].params).toEqual(['c-oauth_client', 'tenant-1', 'admin-1', 'outbox-1']);
  });

  it('fails closed when the consent changed before revocation', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(revokeInput())
    ).rejects.toThrow(new AgentAccessConflictError('Agent consent changed before revocation'));
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push({ last_mutation_id: 'outbox-other' });
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(revokeInput())
    ).rejects.toThrow(AgentAccessConflictError);
  });

  it('fails closed when the outbox row is missing', async () => {
    const { repository } = mutRepo();
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(revokeInput())
    ).rejects.toThrow(new AgentAccessConflictError('Agent consent revocation outbox is missing'));
  });

  it.each([
    ['an array payload', '[]'],
    ['a null payload', 'null'],
    ['a scalar payload', '"x"'],
    [
      'a non-array family JTI list',
      JSON.stringify({ family_ids: [], family_jtis: 'j', reason: 'r' }),
    ],
    ['a numeric family ID', JSON.stringify({ family_ids: [1], family_jtis: ['j'], reason: 'r' })],
    ['an empty family ID', JSON.stringify({ family_ids: [''], family_jtis: ['j'], reason: 'r' })],
    ['a numeric family JTI', JSON.stringify({ family_ids: ['f'], family_jtis: [1], reason: 'r' })],
    ['an empty family JTI', JSON.stringify({ family_ids: ['f'], family_jtis: [''], reason: 'r' })],
    ['a missing family list', JSON.stringify({ family_jtis: [], reason: 'r' })],
    ['an empty reason', JSON.stringify({ family_ids: [], family_jtis: [], reason: '' })],
    ['a non-string reason', JSON.stringify({ family_ids: [], family_jtis: [], reason: 1 })],
  ])('rejects %s in the stored outbox', async (_name, stored) => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ payload: stored });
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(revokeInput())
    ).rejects.toThrow(new TypeError('Stored Agent token revocation payload is invalid'));
  });
});
