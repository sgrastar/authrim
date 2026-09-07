import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigurationRepository, AgentToolCatalog } from '../../../core';
import { CloudflareAgentConfigurationResourceReader } from '../configuration-resources';

const subject = {
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  grantGeneration: 2,
  consentVersion: 3,
  actorSub: 'client:client-1',
  clientId: 'client-1',
};

function reader(overrides: Record<string, unknown> = {}) {
  const repository = {
    isActiveTenant: vi.fn().mockResolvedValue(true),
    listTaskSets: vi.fn().mockResolvedValue([]),
    listScopePolicies: vi.fn().mockResolvedValue([]),
    listPlans: vi.fn().mockResolvedValue([]),
    getLatestPlan: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  const catalog = { version: 'catalog-v1', list: () => [], get: () => undefined };
  return {
    repository,
    reader: new CloudflareAgentConfigurationResourceReader(
      repository as unknown as AgentConfigurationRepository,
      catalog as AgentToolCatalog
    ),
  };
}

describe('Cloudflare dynamic configuration Resource reader', () => {
  it('fails closed for an inactive or missing tenant before reading configuration', async () => {
    const current = reader({ isActiveTenant: vi.fn().mockResolvedValue(false) });
    await expect(current.reader.readTenantSummary(subject)).resolves.toBeNull();
    expect(current.repository.listScopePolicies).not.toHaveBeenCalled();
  });

  it('returns a Plan only for the exact Grant generation, consent, actor, and client', async () => {
    const plan = {
      id: 'plan-1',
      version: 1,
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 1,
      consentVersion: 3,
      actorSub: 'client:client-1',
      clientId: 'client-1',
      definitionDigest: 'digest',
      status: 'ready',
      stage: 'apply',
      appliedStepCount: 0,
      expiresAt: 10,
      payloadPurgeAt: 20,
      createdAt: 1,
      updatedAt: 2,
    };
    const current = reader({ getLatestPlan: vi.fn().mockResolvedValue(plan) });
    await expect(current.reader.readPlan(subject, 'plan-1')).resolves.toBeNull();
    await expect(
      current.reader.readPlan({ ...subject, grantGeneration: 1 }, 'plan-1')
    ).resolves.toMatchObject({ id: 'plan-1', digest: 'digest' });
  });
});
