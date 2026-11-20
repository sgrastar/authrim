import { describe, expect, it } from 'vitest';
import {
  assertScopePolicyNarrows,
  normalizeAgentScopePolicy,
  resolveAgentTaskSetVersion,
  toolSnapshot,
  type AgentScopePolicyDefinition,
} from '../core/configuration';
import { makeCoreCatalog, makeCoreTool } from './helpers/mut-core-fixtures';

const writeTool = makeCoreTool({
  requiredPermissions: ['admin:clients:write', 'admin:clients:read'],
});
const highTool = makeCoreTool({
  id: 'admin.users.suspend',
  name: 'suspend_user',
  requiredPermissions: ['admin:users:suspend'],
  riskLevel: 'high',
});
const catalog = makeCoreCatalog([writeTool, highTool]);

describe('resolveAgentTaskSetVersion', () => {
  it('produces an exact sorted snapshot with a stable digest', async () => {
    const first = await resolveAgentTaskSetVersion({
      toolIds: [writeTool.id, highTool.id],
      catalog,
      creatorPermissions: ['*'],
    });
    expect(first).toEqual({
      catalogVersion: 'catalog-v1',
      tools: [
        {
          toolId: highTool.id,
          toolName: 'suspend_user',
          contractVersion: '1',
          schemaDigest: highTool.schemaDigest,
          permissions: ['admin:users:suspend'],
          requiredScope: 'agent:write',
          riskLevel: 'high',
          requiresElevation: true,
        },
        {
          toolId: writeTool.id,
          toolName: 'update_client_metadata',
          contractVersion: '1',
          schemaDigest: writeTool.schemaDigest,
          permissions: ['admin:clients:read', 'admin:clients:write'],
          requiredScope: 'agent:write',
          riskLevel: 'standard',
          requiresElevation: false,
        },
      ],
      permissions: ['admin:clients:read', 'admin:clients:write', 'admin:users:suspend'],
      digest: first.digest,
    });
    expect(first.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const reordered = await resolveAgentTaskSetVersion({
      toolIds: [highTool.id, writeTool.id, highTool.id],
      catalog,
      creatorPermissions: ['*'],
    });
    expect(reordered.digest).toBe(first.digest);
    const other = await resolveAgentTaskSetVersion({
      toolIds: [writeTool.id],
      catalog,
      creatorPermissions: ['*'],
    });
    expect(other.digest).not.toBe(first.digest);
  });

  it('accepts exactly 256 tool IDs and rejects 0 or 257', async () => {
    await expect(
      resolveAgentTaskSetVersion({
        toolIds: Array(256).fill(writeTool.id),
        catalog,
        creatorPermissions: ['*'],
      })
    ).resolves.toMatchObject({ tools: [{ toolId: writeTool.id }] });
    for (const toolIds of [[], Array(257).fill(writeTool.id)]) {
      await expect(
        resolveAgentTaskSetVersion({ toolIds, catalog, creatorPermissions: ['*'] })
      ).rejects.toThrow('Task Set must contain between 1 and 256 Tools');
    }
  });

  it('rejects malformed tool IDs with a named field', async () => {
    await expect(
      resolveAgentTaskSetVersion({ toolIds: ['bad id'], catalog, creatorPermissions: ['*'] })
    ).rejects.toThrow('Tool ID is invalid');
  });

  it('requires the creator to hold every tool permission', async () => {
    await expect(
      resolveAgentTaskSetVersion({
        toolIds: [writeTool.id],
        catalog,
        creatorPermissions: ['admin:clients:read'],
      })
    ).rejects.toThrow(`Tool exceeds creator permissions: ${writeTool.id}`);
  });
});

const policy: AgentScopePolicyDefinition = {
  tenantIds: ['tenant-a'],
  environmentIds: ['prod'],
  domains: ['clients'],
  resourceIds: ['client-a'],
  selectors: [{ catalogId: 'clients-by-tag', version: 1, value: 'managed' }],
  allowedFields: ['client_name'],
  piiMode: 'masked',
  maxPerCall: 20,
  maxPlanOperations: 10,
  maxBulkTenants: 25,
};

describe('normalizeAgentScopePolicy', () => {
  it('returns a sorted, deduplicated definition', async () => {
    const result = await normalizeAgentScopePolicy(
      {
        ...policy,
        environmentIds: ['prod', 'dev', 'prod'],
        domains: ['users', 'clients'],
        allowedFields: ['name', 'email'],
        selectors: [
          { catalogId: 'z', version: 1, value: 'v' },
          { catalogId: 'a', version: 2, value: 'v' },
        ],
        piiMode: 'explicit_unmasked',
      },
      'tenant-a'
    );
    expect(result.definition).toEqual({
      tenantIds: ['tenant-a'],
      environmentIds: ['dev', 'prod'],
      domains: ['clients', 'users'],
      resourceIds: ['client-a'],
      selectors: [
        { catalogId: 'a', version: 2, value: 'v' },
        { catalogId: 'z', version: 1, value: 'v' },
      ],
      allowedFields: ['email', 'name'],
      piiMode: 'explicit_unmasked',
      maxPerCall: 20,
      maxPlanOperations: 10,
      maxBulkTenants: 25,
    });
    expect(result.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('accepts inclusive quantitative boundaries', async () => {
    for (const limits of [
      { maxPerCall: 1, maxPlanOperations: 1, maxBulkTenants: 1 },
      { maxPerCall: 100, maxPlanOperations: 100, maxBulkTenants: 1000 },
    ]) {
      await expect(
        normalizeAgentScopePolicy({ ...policy, ...limits }, 'tenant-a')
      ).resolves.toMatchObject({
        definition: limits,
      });
    }
  });

  it.each([
    ['null policy', null],
    ['unknown piiMode', { ...policy, piiMode: 'unmasked' }],
    ['fractional maxPerCall', { ...policy, maxPerCall: 1.5 }],
    ['zero maxPerCall', { ...policy, maxPerCall: 0 }],
    ['maxPerCall over 100', { ...policy, maxPerCall: 101 }],
    ['non-integer maxPlanOperations', { ...policy, maxPlanOperations: Number.NaN }],
    ['zero maxPlanOperations', { ...policy, maxPlanOperations: 0 }],
    ['maxPlanOperations over 100', { ...policy, maxPlanOperations: 101 }],
    ['non-integer maxBulkTenants', { ...policy, maxBulkTenants: 2.5 }],
    ['zero maxBulkTenants', { ...policy, maxBulkTenants: 0 }],
    ['maxBulkTenants over 1000', { ...policy, maxBulkTenants: 1001 }],
  ])('rejects %s', async (_label, value) => {
    await expect(
      normalizeAgentScopePolicy(value as unknown as AgentScopePolicyDefinition, 'tenant-a')
    ).rejects.toThrow('Scope Policy quantitative limits are invalid');
  });

  it.each([
    ['tenantIds', { tenantIds: ['tenant-a', 'bad tenant'] }],
    ['environmentIds', { environmentIds: ['bad env'] }],
    ['domains', { domains: ['bad/domain'] }],
    ['resourceIds', { resourceIds: [''] }],
    ['allowedFields', { allowedFields: ['x'.repeat(129)] }],
  ])('names the invalid %s axis', async (field, override) => {
    await expect(normalizeAgentScopePolicy({ ...policy, ...override }, 'tenant-a')).rejects.toThrow(
      `${field} is invalid`
    );
  });

  it('bounds the tenant list and requires the owning tenant', async () => {
    const many = (n: number) => ['tenant-a', ...Array.from({ length: n - 1 }, (_, i) => `t-${i}`)];
    await expect(
      normalizeAgentScopePolicy({ ...policy, tenantIds: many(1000) }, 'tenant-a')
    ).resolves.toBeDefined();
    for (const tenantIds of [[], many(1001), ['tenant-b']]) {
      await expect(normalizeAgentScopePolicy({ ...policy, tenantIds }, 'tenant-a')).rejects.toThrow(
        'Scope Policy must include its owning tenant and at most 1000 targets'
      );
    }
  });

  it.each([
    ['catalogId', { catalogId: 'bad id' }],
    ['fractional version', { version: 1.5 }],
    ['zero version', { version: 0 }],
    ['value', { value: '' }],
  ])('rejects a selector with invalid %s', async (_label, override) => {
    await expect(
      normalizeAgentScopePolicy(
        { ...policy, selectors: [{ ...policy.selectors[0], ...override }] },
        'tenant-a'
      )
    ).rejects.toThrow('Scope Policy selector is invalid');
  });
});

describe('assertScopePolicyNarrows', () => {
  const wide: AgentScopePolicyDefinition = {
    ...policy,
    tenantIds: ['tenant-a', 'tenant-b'],
    environmentIds: ['prod', 'dev'],
    domains: ['clients', 'users'],
    resourceIds: ['client-a', 'client-b'],
    selectors: [
      { catalogId: 'clients-by-tag', version: 1, value: 'managed' },
      { catalogId: 'users-by-tag', version: 1, value: 'vip' },
    ],
    allowedFields: ['client_name', 'email'],
    piiMode: 'explicit_unmasked',
  };

  it('accepts identical and narrower policies', () => {
    expect(() => assertScopePolicyNarrows(wide, wide)).not.toThrow();
    expect(() => assertScopePolicyNarrows(wide, policy)).not.toThrow();
    expect(() => assertScopePolicyNarrows(policy, policy)).not.toThrow();
    expect(() =>
      assertScopePolicyNarrows(wide, { ...policy, piiMode: 'explicit_unmasked' })
    ).not.toThrow();
  });

  it.each([
    ['tenantIds', { tenantIds: ['tenant-c'] }],
    ['environmentIds', { environmentIds: ['staging'] }],
    ['domains', { domains: ['roles'] }],
    ['resourceIds', { resourceIds: ['client-z'] }],
    ['allowedFields', { allowedFields: ['phone'] }],
    ['selector catalog', { selectors: [{ catalogId: 'other', version: 1, value: 'managed' }] }],
    [
      'selector version',
      { selectors: [{ catalogId: 'clients-by-tag', version: 2, value: 'managed' }] },
    ],
    [
      'one extra selector',
      {
        selectors: [
          { catalogId: 'clients-by-tag', version: 1, value: 'managed' },
          { catalogId: 'x', version: 1, value: 'y' },
        ],
      },
    ],
    ['maxPerCall', { maxPerCall: 21 }],
    ['maxPlanOperations', { maxPlanOperations: 11 }],
    ['maxBulkTenants', { maxBulkTenants: 26 }],
    ['piiMode', { piiMode: 'explicit_unmasked' as const }],
  ])('rejects broadening %s', (_label, override) => {
    expect(() => assertScopePolicyNarrows(policy, { ...policy, ...override })).toThrow(
      'Scope Policy override may only narrow the named policy'
    );
  });
});

describe('toolSnapshot', () => {
  it('projects the authorization-relevant contract', () => {
    expect(toolSnapshot(writeTool)).toEqual({
      tool_id: writeTool.id,
      name: 'update_client_metadata',
      contract_version: '1',
      schema_digest: writeTool.schemaDigest,
      permissions: ['admin:clients:write', 'admin:clients:read'],
      risk_level: 'standard',
      requires_elevation: false,
    });
    expect(toolSnapshot(highTool)).toMatchObject({ risk_level: 'high', requires_elevation: true });
  });
});
