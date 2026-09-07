import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import { AgentConfigurationRepository } from '../repositories/agent-configuration-repository';

describe('Agent secret reference repository', () => {
  it('derives expired list status at read time without adding a lifecycle transition', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const repository = new AgentConfigurationRepository({ query } as unknown as DatabaseAdapter);
    await repository.listSecretRefs('tenant-1', 5_000);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("THEN 'expired'"), [
      5_000,
      'tenant-1',
    ]);
  });

  it('resolves only an exact tenant, resource, purpose, active, unexpired binding', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        id: 'asr_1234567890abcdef',
        tenant_id: 'tenant-1',
        resource_type: 'oidc_client',
        resource_id: 'client-1',
        purpose: 'client authentication',
        provider_key: 'tenant:tenant-1:agent:client-1',
        status: 'active',
        created_by: 'admin-1',
        created_at: 1,
        expires_at: 10_000,
        revoked_at: null,
        revoked_by: null,
      },
    ]);
    const repository = new AgentConfigurationRepository({ query } as unknown as DatabaseAdapter);
    await expect(
      repository.resolveActiveSecretRef({
        tenantId: 'tenant-1',
        id: 'asr_1234567890abcdef',
        resourceType: 'oidc_client',
        resourceId: 'client-1',
        purpose: 'client authentication',
        now: 5_000,
      })
    ).resolves.toMatchObject({ providerKey: 'tenant:tenant-1:agent:client-1' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'active'"), [
      'tenant-1',
      'asr_1234567890abcdef',
      'oidc_client',
      'client-1',
      'client authentication',
      5_000,
    ]);
  });

  it('revokes and writes audit evidence in one guarded DatabaseAdapter batch', async () => {
    const batch = vi.fn().mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 1 }]);
    const repository = new AgentConfigurationRepository({ batch } as unknown as DatabaseAdapter);
    await expect(
      repository.revokeSecretRef({
        tenantId: 'tenant-1',
        id: 'asr_1234567890abcdef',
        revokedBy: 'admin-1',
        now: 2_000,
        audit: {
          id: 'audit-1',
          tenantId: 'tenant-1',
          action: 'agent.secret_ref.revoked',
          resourceType: 'agent_secret_ref',
          resourceId: 'asr_1234567890abcdef',
          severity: 'info',
          actorType: 'admin_user',
          actorSub: 'admin_user:admin-1',
          createdAt: 2_000,
          metadata: {},
        },
      })
    ).resolves.toBe(true);
    const statements = batch.mock.calls[0]![0];
    expect(statements[0].sql).toContain("status = 'revoked'");
    expect(statements[1].sql).toContain('FROM agent_secret_refs');
    expect(statements[1].params).toContain('audit-1');
  });
});
