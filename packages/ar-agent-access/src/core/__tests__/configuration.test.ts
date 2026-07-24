import { describe, expect, it } from 'vitest';
import { createAgentToolCatalog } from '../tool-catalog';
import { sealAgentToolDefinition } from '../tool-contract';
import {
  assertNoRawSecrets,
  assertScopePolicyNarrows,
  normalizeAgentScopePolicy,
  resolveAgentConfigurationPlan,
  resolveAgentTaskSetVersion,
  type AgentScopePolicyDefinition,
} from '../configuration';
import type { AgentToolDefinition } from '../types';

const schemaValidator = {
  validate(schema: AgentToolDefinition['inputSchema'], input: unknown) {
    const properties = schema.properties as Record<string, unknown> | undefined;
    const record =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    return {
      valid:
        record !== null &&
        (!schema.required ||
          (schema.required as string[]).every((field) => Object.hasOwn(record, field))) &&
        (schema.additionalProperties !== false ||
          Object.keys(record).every((field) => properties && Object.hasOwn(properties, field))),
    };
  },
};

const tool: AgentToolDefinition = sealAgentToolDefinition({
  id: 'admin.write.clients.metadata',
  name: 'update_client_metadata',
  title: 'Update client metadata',
  description: 'Updates allowlisted display metadata.',
  contractVersion: '1',
  requiredPermissions: ['admin:clients:write'],
  requiredScope: 'agent:write',
  riskLevel: 'standard',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      client_id: { type: 'string' },
      client_name: { type: 'string' },
    },
    required: ['client_id'],
  },
});

const policy: AgentScopePolicyDefinition = {
  tenantIds: ['tenant-a'],
  environmentIds: ['prod'],
  domains: ['clients'],
  resourceIds: ['client-a', 'client-b'],
  selectors: [{ catalogId: 'clients-by-tag', version: 1, value: 'managed' }],
  allowedFields: ['client_name', 'description'],
  piiMode: 'masked',
  maxPerCall: 20,
  maxPlanOperations: 10,
  maxBulkTenants: 25,
};

describe('Agent Configuration Copilot contracts', () => {
  it('resolves an immutable Task Set snapshot from real Tool IDs and creator permissions', async () => {
    const resolved = await resolveAgentTaskSetVersion({
      toolIds: [tool.id, tool.id],
      catalog: createAgentToolCatalog('catalog-v1', [tool]),
      creatorPermissions: ['admin:clients:*'],
    });
    expect(resolved).toMatchObject({
      catalogVersion: 'catalog-v1',
      permissions: ['admin:clients:write'],
      tools: [{ toolId: tool.id, contractVersion: '1', riskLevel: 'standard' }],
    });
    expect(resolved.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('rejects unknown or creator-inaccessible Task Set tools', async () => {
    const catalog = createAgentToolCatalog('catalog-v1', [tool]);
    await expect(
      resolveAgentTaskSetVersion({
        toolIds: ['missing'],
        catalog,
        creatorPermissions: ['admin:*'],
      })
    ).rejects.toThrow('Unknown Tool ID');
    await expect(
      resolveAgentTaskSetVersion({
        toolIds: [tool.id],
        catalog,
        creatorPermissions: ['admin:clients:read'],
      })
    ).rejects.toThrow('exceeds creator permissions');
  });

  it('normalizes all six Scope Policy axes and enforces tenant ownership', async () => {
    const normalized = await normalizeAgentScopePolicy(
      { ...policy, resourceIds: ['client-b', 'client-a', 'client-a'] },
      'tenant-a'
    );
    expect(normalized.definition.resourceIds).toEqual(['client-a', 'client-b']);
    expect(normalized.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(normalizeAgentScopePolicy(policy, 'tenant-b')).rejects.toThrow('owning tenant');
    await expect(
      normalizeAgentScopePolicy({ ...policy, tenantIds: ['tenant-a', 'tenant-b'] }, 'tenant-a')
    ).resolves.toMatchObject({ definition: { tenantIds: ['tenant-a', 'tenant-b'] } });
  });

  it('allows a Grant override to narrow but never broaden a named Scope Policy', () => {
    expect(() =>
      assertScopePolicyNarrows(policy, {
        ...policy,
        resourceIds: ['client-a'],
        allowedFields: ['client_name'],
        maxPerCall: 1,
      })
    ).not.toThrow();
    expect(() =>
      assertScopePolicyNarrows(policy, { ...policy, resourceIds: [...policy.resourceIds, 'x'] })
    ).toThrow('only narrow');
    expect(() =>
      assertScopePolicyNarrows(policy, { ...policy, piiMode: 'explicit_unmasked' })
    ).toThrow('only narrow');
  });

  it('rejects raw secrets recursively while accepting opaque secret_ref handles', () => {
    expect(() =>
      assertNoRawSecrets({ credentials: { secret_ref: 'asr_1234567890abcdef' } })
    ).not.toThrow();
    expect(() => assertNoRawSecrets({ nested: [{ client_secret: 'plaintext' }] })).toThrow(
      'Raw secret field is forbidden'
    );
    expect(() => assertNoRawSecrets({ secret_ref: 'not-a-reference' })).toThrow(
      'Invalid opaque secret_ref'
    );
  });

  it('resolves a version-bound plan and rejects contract drift or raw secrets', async () => {
    const catalog = createAgentToolCatalog('catalog-v1', [tool]);
    const resolved = await resolveAgentConfigurationPlan({
      catalog,
      maxOperations: 10,
      schemaValidator,
      definition: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-1',
            operation: tool.id,
            toolContractVersion: '1',
            input: { client_id: 'client-a', client_name: 'Renamed' },
            resourcePrecondition: 'etag:v1',
          },
        ],
      },
    });
    expect(resolved.risks).toEqual(['standard']);
    expect(resolved.definition.goal).toBe('Apply an approved Authrim configuration change');
    expect(resolved.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(
      resolveAgentConfigurationPlan({
        catalog,
        maxOperations: 10,
        schemaValidator,
        definition: { ...resolved.definition, goal: '   ' },
      })
    ).rejects.toThrow('schema version is invalid');
    await expect(
      resolveAgentConfigurationPlan({
        catalog,
        maxOperations: 10,
        schemaValidator,
        definition: { ...resolved.definition, goal: 'Use a different target outcome' },
      })
    ).resolves.not.toMatchObject({ digest: resolved.digest });
    await expect(
      resolveAgentConfigurationPlan({
        catalog,
        maxOperations: 10,
        schemaValidator,
        definition: {
          schemaVersion: 'authrim-agent-plan-v1',
          goal: 'Apply an approved Authrim configuration change',
          steps: [
            {
              id: 'step-1',
              operation: tool.id,
              toolContractVersion: '2',
              input: { client_id: 'client-a' },
            },
          ],
        },
      })
    ).rejects.toThrow('contract is unavailable');
    await expect(
      resolveAgentConfigurationPlan({
        catalog,
        maxOperations: 10,
        schemaValidator,
        definition: {
          schemaVersion: 'authrim-agent-plan-v1',
          goal: 'Apply an approved Authrim configuration change',
          steps: [
            {
              id: 'step-1',
              operation: tool.id,
              toolContractVersion: '1',
              input: { client_secret: 'plaintext' },
              resourcePrecondition: 'etag:v1',
            },
          ],
        },
      })
    ).rejects.toThrow('Raw secret field is forbidden');

    await expect(
      resolveAgentConfigurationPlan({
        catalog,
        maxOperations: 10,
        schemaValidator,
        definition: {
          schemaVersion: 'authrim-agent-plan-v1',
          goal: 'Apply an approved Authrim configuration change',
          steps: [
            {
              id: 'step-1',
              operation: tool.id,
              toolContractVersion: '1',
              input: { client_id: 'client-a', uncontracted_field: true },
              resourcePrecondition: 'etag:v1',
            },
          ],
        },
      })
    ).rejects.toThrow('Plan operation input is invalid');
  });
});
