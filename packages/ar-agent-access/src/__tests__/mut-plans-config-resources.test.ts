import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigurationRepository } from '../core';
import { CloudflareAgentConfigurationResourceReader } from '../platform/cloudflare/configuration-resources';
import { createAdminToolCatalog } from '../protocol/mcp';

const subject = {
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  grantGeneration: 2,
  consentVersion: 3,
  actorSub: 'client:client-1',
  clientId: 'client-1',
};

const ownedPlan = {
  id: 'acp-own',
  version: 2,
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  grantGeneration: 2,
  consentVersion: 3,
  actorSub: 'client:client-1',
  clientId: 'client-1',
  definitionDigest: 'digest-own',
  status: 'ready',
  stage: 'apply',
  createdAt: 10,
  updatedAt: 20,
  expiresAt: 30,
  definition: { schemaVersion: 'authrim-agent-plan-v1', goal: 'g', steps: [] },
};

function reader(overrides: Record<string, unknown> = {}) {
  const repository = {
    isActiveTenant: vi.fn().mockResolvedValue(true),
    listTaskSets: vi.fn().mockResolvedValue([
      {
        id: 'ats-stored',
        name: 'Stored',
        currentVersion: 4,
        status: 'active',
        version: { digest: 'task-digest' },
      },
    ]),
    listScopePolicies: vi.fn().mockResolvedValue([
      {
        id: 'asp-1',
        name: 'Policy',
        currentVersion: 2,
        definitionDigest: 'policy-digest',
        status: 'retired',
        extra: 'not-exposed',
      },
    ]),
    listPlans: vi.fn().mockResolvedValue([]),
    getLatestPlan: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  const catalog = createAdminToolCatalog();
  return {
    repository,
    reader: new CloudflareAgentConfigurationResourceReader(
      repository as unknown as AgentConfigurationRepository,
      catalog
    ),
  };
}

describe('configuration Resource reader: tenant summary', () => {
  it('summarizes task sets, scope policies and only the subject-owned recent Plans', async () => {
    const others = [
      { ...ownedPlan, id: 'p-grant', grantId: 'grant-2' },
      { ...ownedPlan, id: 'p-generation', grantGeneration: 1 },
      { ...ownedPlan, id: 'p-consent', consentVersion: 4 },
      { ...ownedPlan, id: 'p-actor', actorSub: 'client:other' },
      { ...ownedPlan, id: 'p-client', clientId: 'client-2' },
    ];
    const current = reader({ listPlans: vi.fn().mockResolvedValue([...others, ownedPlan]) });
    const summary = (await current.reader.readTenantSummary(subject)) as Record<string, unknown>;
    const taskSets = summary.task_sets as Array<Record<string, unknown>>;
    expect(taskSets.at(-1)).toEqual({
      id: 'ats-stored',
      name: 'Stored',
      version: 4,
      digest: 'task-digest',
      status: 'active',
    });
    for (const item of taskSets) {
      expect(Object.keys(item).sort()).toEqual(['digest', 'id', 'name', 'status', 'version']);
    }
    expect(summary).toEqual({
      schema_version: 'authrim-tenant-configuration-summary-v1',
      tenant_id: 'tenant-1',
      catalog_version: 'admin-agent-access-v9',
      task_sets: taskSets,
      scope_policies: [
        { id: 'asp-1', name: 'Policy', version: 2, digest: 'policy-digest', status: 'retired' },
      ],
      recent_plans: [
        {
          id: 'acp-own',
          version: 2,
          digest: 'digest-own',
          status: 'ready',
          stage: 'apply',
          updated_at: 20,
        },
      ],
    });
    expect(current.repository.isActiveTenant).toHaveBeenCalledWith('tenant-1');
    expect(current.repository.listTaskSets).toHaveBeenCalledWith('tenant-1');
    expect(current.repository.listScopePolicies).toHaveBeenCalledWith('tenant-1');
    expect(current.repository.listPlans).toHaveBeenCalledWith('tenant-1', 25);
  });
});

describe('configuration Resource reader: Plan resource', () => {
  it('returns nothing for an inactive tenant without reading the Plan', async () => {
    const current = reader({ isActiveTenant: vi.fn().mockResolvedValue(false) });
    await expect(current.reader.readPlan(subject, 'acp-own')).resolves.toBeNull();
    expect(current.repository.getLatestPlan).not.toHaveBeenCalled();
  });

  it('projects an owned Plan with explicit nulls for unset fields', async () => {
    const current = reader({ getLatestPlan: vi.fn().mockResolvedValue(ownedPlan) });
    await expect(current.reader.readPlan(subject, 'acp-own')).resolves.toEqual({
      schema_version: 'authrim-agent-plan-resource-v1',
      id: 'acp-own',
      version: 2,
      digest: 'digest-own',
      status: 'ready',
      stage: 'apply',
      definition: ownedPlan.definition,
      diff: null,
      validation: null,
      result: null,
      created_at: 10,
      updated_at: 20,
      expires_at: 30,
    });
    expect(current.repository.getLatestPlan).toHaveBeenCalledWith('tenant-1', 'acp-own');
  });

  it('projects populated Plan payloads and a purged definition', async () => {
    const current = reader({
      getLatestPlan: vi.fn().mockResolvedValue({
        ...ownedPlan,
        definition: undefined,
        diff: { changes: [] },
        validation: { valid: true },
        result: { applied_steps: 1 },
      }),
    });
    await expect(current.reader.readPlan(subject, 'acp-own')).resolves.toMatchObject({
      definition: null,
      diff: { changes: [] },
      validation: { valid: true },
      result: { applied_steps: 1 },
    });
  });
});
