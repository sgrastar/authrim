import { describe, expect, it } from 'vitest';
import {
  isSelfServiceClientMetadataDocumentId,
  normalizeSelfServiceAgentScopes,
  resolveSelfServiceAgentAccessSnapshot,
} from '../self-service';
import { createAgentToolCatalog } from '../tool-catalog';
import { sealAgentToolDefinition } from '../tool-contract';
import type { AgentScope } from '../types';

function tool(id: string, requiredScope: AgentScope, permission: string) {
  return sealAgentToolDefinition({
    id,
    name: id.replaceAll('.', '_'),
    title: id,
    description: `Execute ${id}.`,
    contractVersion: '1',
    requiredPermissions: [permission],
    riskLevel: 'low',
    requiredScope,
    inputSchema: { type: 'object' },
  });
}

const catalog = createAgentToolCatalog('catalog-1', [
  tool('admin.read.clients.list', 'agent:read', 'admin:clients:read'),
  tool('admin.read.users.search', 'agent:user-data:read', 'admin:users:read'),
  tool('admin.write.clients.metadata', 'agent:write', 'admin:clients:write'),
  tool('admin.write.bulk.plan.create', 'agent:write', 'admin:bulk:write'),
]);

const base = {
  tenantId: 'tenant-a',
  adminUserId: 'admin-a',
  clientId: 'client-a',
  grantId: 'grant-a',
  approvedScopes: ['agent:read'] as readonly string[],
  adminPermissions: ['admin:clients:read'] as readonly string[],
  catalog,
  expiresAt: 1_000_000,
};

describe('self-service scope normalization', () => {
  it('deduplicates and orders only approved self-service scopes', () => {
    expect(
      normalizeSelfServiceAgentScopes([
        'agent:write',
        'agent:read',
        'agent:user-data:read',
        'agent:write',
        '',
      ])
    ).toEqual(['agent:read', 'agent:user-data:read', 'agent:write']);
  });

  it('requires the base read scope and refuses a privileged scope', () => {
    expect(() => normalizeSelfServiceAgentScopes(['agent:write'])).toThrow('requires agent:read');
    expect(() => normalizeSelfServiceAgentScopes(['agent:read', 'agent:admin'])).toThrow(
      'scope is not supported'
    );
  });

  it('rejects percent-decoded traversal and malformed escapes in a metadata URL', () => {
    for (const url of [
      'https://agent.example/a/%2E/client.json',
      'https://agent.example/a/%2E%2E/client.json',
      'https://agent.example/a/%zz/client.json',
    ]) {
      expect(isSelfServiceClientMetadataDocumentId(url)).toBe(false);
    }
  });
});

describe('resolveSelfServiceAgentAccessSnapshot', () => {
  it('pins only tenant-scoped tools permitted by both OAuth scopes and live Admin RBAC', async () => {
    const snapshot = await resolveSelfServiceAgentAccessSnapshot({
      ...base,
      approvedScopes: ['agent:read', 'agent:user-data:read', 'agent:write'],
      adminPermissions: ['admin:clients:read', 'admin:users:read', 'admin:clients:write'],
      authorizationDetails: [
        { type: 'authrim_admin_agent', max_subjects_per_call: 20 },
        { type: 'authrim_admin_agent', max_subjects_per_call: 7 },
      ],
    });

    expect(snapshot.scopes).toEqual(['agent:read', 'agent:user-data:read', 'agent:write']);
    expect(snapshot.resolvedTools.map((item) => item.toolId)).toEqual([
      'admin.read.clients.list',
      'admin.read.users.search',
      'admin.write.clients.metadata',
    ]);
    expect(
      snapshot.resolvedTools.some((item) => item.toolId === 'admin.write.bulk.plan.create')
    ).toBe(false);
    expect(snapshot.permissions).toEqual([
      'admin:clients:read',
      'admin:clients:write',
      'admin:users:read',
    ]);
    expect(snapshot.resolvedScopeConstraints).toEqual({
      tenantIds: ['tenant-a'],
      piiMode: 'masked',
      maxPerCall: 7,
      maxPerPlan: 25,
      maxPerBulkPlan: 1,
    });
    expect(snapshot.scopePolicyDefinition.tenantIds).toEqual(['tenant-a']);
    expect(snapshot.scopePolicyDefinition.piiMode).toBe('masked');
    expect(snapshot.accessSnapshotHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps a read-only grant free of user-data and write tools', async () => {
    const snapshot = await resolveSelfServiceAgentAccessSnapshot({
      ...base,
      adminPermissions: ['admin:clients:read', 'admin:users:read', 'admin:clients:write'],
    });

    expect(snapshot.scopes).toEqual(['agent:read']);
    expect(snapshot.resolvedTools.map((item) => item.toolId)).toEqual(['admin.read.clients.list']);
    expect(snapshot.permissions).toEqual(['admin:clients:read']);
    expect(snapshot.resolvedScopeConstraints.maxPerCall).toBe(50);
  });

  it('denies a grant when no candidate Tool fits the Admin permission ceiling', async () => {
    await expect(
      resolveSelfServiceAgentAccessSnapshot({ ...base, adminPermissions: [] })
    ).rejects.toThrow('No Agent Tools are available');
  });

  it('denies user-data scope without a user-read Tool, even if other reads remain', async () => {
    await expect(
      resolveSelfServiceAgentAccessSnapshot({
        ...base,
        approvedScopes: ['agent:read', 'agent:user-data:read'],
      })
    ).rejects.toThrow('agent:user-data:read requires admin:users:read');
  });

  it('denies write scope without a permitted write Tool', async () => {
    await expect(
      resolveSelfServiceAgentAccessSnapshot({
        ...base,
        approvedScopes: ['agent:read', 'agent:write'],
      })
    ).rejects.toThrow('agent:write is unavailable');
  });

  it.each([
    { taskSetVersion: 0 },
    { taskSetVersion: 1.5 },
    { scopePolicyVersion: 0 },
    { scopePolicyVersion: Number.NaN },
  ])('rejects an invalid pinned configuration version: %#', async (versions) => {
    await expect(resolveSelfServiceAgentAccessSnapshot({ ...base, ...versions })).rejects.toThrow(
      'configuration versions must be positive integers'
    );
  });

  it('binds the snapshot hash to tenant, client, grant, and expiration identities', async () => {
    const original = await resolveSelfServiceAgentAccessSnapshot(base);
    for (const changed of [
      { tenantId: 'tenant-b' },
      { clientId: 'client-b' },
      { grantId: 'grant-b' },
      { expiresAt: base.expiresAt + 1 },
    ]) {
      const next = await resolveSelfServiceAgentAccessSnapshot({ ...base, ...changed });
      expect(next.accessSnapshotHash).not.toBe(original.accessSnapshotHash);
    }
  });
});
