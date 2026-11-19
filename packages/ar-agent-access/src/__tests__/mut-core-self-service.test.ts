import { describe, expect, it } from 'vitest';
import { canonicalizeJson, sha256Base64Url } from '../core/canonical-json';
import {
  isSelfServiceClientMetadataDocumentId,
  normalizeSelfServiceAgentAuthorizationDetails,
  resolveSelfServiceAgentAccessSnapshot,
  SELF_SERVICE_GRANT_TTL_MS,
  selfServiceRevocationOutboxId,
} from '../core/self-service';
import { createAgentToolCatalog } from '../core/tool-catalog';
import { sealAgentToolDefinition } from '../core/tool-contract';
import type { AgentScope, JsonValue } from '../core/types';

const CONTRACT = 'authorization_details is outside the Admin Agent contract';

describe('self-service identifiers', () => {
  it('uses a seven-day grant TTL', () => {
    expect(SELF_SERVICE_GRANT_TTL_MS).toBe(604_800_000);
  });

  it('rejects credentials in the metadata URL and bounds its length', () => {
    expect(isSelfServiceClientMetadataDocumentId('https://:pw@agent.example/client.json')).toBe(
      false
    );
    const prefix = 'https://agent.example/';
    const exact = prefix + 'a'.repeat(2048 - prefix.length);
    expect(isSelfServiceClientMetadataDocumentId(exact)).toBe(true);
    expect(isSelfServiceClientMetadataDocumentId(exact + 'a')).toBe(false);
  });

  it('ignores dot-like text in the query string', () => {
    expect(isSelfServiceClientMetadataDocumentId('https://agent.example/client.json?v=/../x')).toBe(
      true
    );
  });

  it('derives the revocation outbox ID within the length bound', () => {
    expect(selfServiceRevocationOutboxId('t1')).toBe('outbox_t1');
    expect(selfServiceRevocationOutboxId('x'.repeat(128))).toBe(`outbox_${'x'.repeat(128)}`);
    for (const id of ['', 'x'.repeat(129)]) {
      expect(() => selfServiceRevocationOutboxId(id)).toThrow(
        'Self-service transition ID is invalid'
      );
    }
  });
});

describe('normalizeSelfServiceAgentAuthorizationDetails boundaries', () => {
  const detail = { type: 'authrim_admin_agent' };

  it('accepts up to 20 details and a type-only detail', () => {
    expect(normalizeSelfServiceAgentAuthorizationDetails(Array(20).fill(detail))).toEqual({
      authorizationDetails: Array(20).fill(detail),
      maxSubjectsPerCall: 50,
    });
    expect(() => normalizeSelfServiceAgentAuthorizationDetails(Array(21).fill(detail))).toThrow(
      CONTRACT
    );
  });

  it('accepts a ceiling of exactly 1 or 50', () => {
    expect(
      normalizeSelfServiceAgentAuthorizationDetails([{ ...detail, max_subjects_per_call: 1 }])
        .maxSubjectsPerCall
    ).toBe(1);
    expect(
      normalizeSelfServiceAgentAuthorizationDetails([{ ...detail, max_subjects_per_call: 50 }])
        .maxSubjectsPerCall
    ).toBe(50);
  });

  it.each([[null], ['detail'], [[detail]], [0]])('rejects a non-object detail %j', (entry) => {
    expect(() => normalizeSelfServiceAgentAuthorizationDetails([entry])).toThrow(CONTRACT);
  });

  it.each([[{ max_subjects_per_call: 1.5 }], [{ max_subjects_per_call: '5' }]])(
    'rejects a non-integer ceiling %j',
    (extra) => {
      expect(() =>
        normalizeSelfServiceAgentAuthorizationDetails([{ ...detail, ...extra }])
      ).toThrow(CONTRACT);
    }
  );

  it('rejects non-array input', () => {
    expect(() => normalizeSelfServiceAgentAuthorizationDetails(detail)).toThrow(CONTRACT);
  });
});

function tool(id: string, requiredScope: AgentScope, permissions: string[]) {
  return sealAgentToolDefinition({
    id,
    name: id.replaceAll('.', '_'),
    title: id,
    description: `Execute ${id}.`,
    contractVersion: '1',
    requiredPermissions: permissions,
    riskLevel: 'low',
    requiredScope,
    inputSchema: { type: 'object' },
  });
}

const base = {
  tenantId: 'tenant-a',
  adminUserId: 'admin-a',
  clientId: 'client-a',
  grantId: 'grant-a',
  approvedScopes: ['agent:read'] as readonly string[],
  adminPermissions: ['*'] as readonly string[],
  expiresAt: 1_000_000,
};

describe('resolveSelfServiceAgentAccessSnapshot candidate selection', () => {
  it('never pins user-data or configuration tools without their scope', async () => {
    const catalog = createAgentToolCatalog('c', [
      tool('admin.read.clients.list', 'agent:read', ['admin:clients:read']),
      tool('admin.read.users.search', 'agent:read', ['admin:users:read']),
      tool('admin.read.configuration.capabilities', 'agent:read', ['admin:clients:read']),
    ]);
    const snapshot = await resolveSelfServiceAgentAccessSnapshot({ ...base, catalog });
    expect(snapshot.resolvedTools.map((t) => t.toolId)).toEqual(['admin.read.clients.list']);
  });

  it('requires every tool permission and accepts users.get as the user-data tool', async () => {
    const catalog = createAgentToolCatalog('c', [
      tool('admin.read.clients.list', 'agent:read', ['admin:clients:read', 'admin:audit:read']),
      tool('admin.read.clients.get', 'agent:read', ['admin:clients:read']),
      tool('admin.read.users.get', 'agent:user-data:read', ['admin:users:read']),
    ]);
    const snapshot = await resolveSelfServiceAgentAccessSnapshot({
      ...base,
      catalog,
      approvedScopes: ['agent:read', 'agent:user-data:read'],
      adminPermissions: ['admin:clients:read', 'admin:users:read'],
    });
    expect(snapshot.resolvedTools).toEqual([
      {
        toolId: 'admin.read.clients.get',
        toolName: 'admin_read_clients_get',
        contractVersion: '1',
        schemaDigest: catalog.list()[1].schemaDigest,
        permissions: ['admin:clients:read'],
        requiredScope: 'agent:read',
        riskLevel: 'low',
        requiresElevation: false,
      },
      expect.objectContaining({
        toolId: 'admin.read.users.get',
        permissions: ['admin:users:read'],
      }),
    ]);
  });
});

describe('resolveSelfServiceAgentAccessSnapshot identifiers and hash', () => {
  const catalog = createAgentToolCatalog('c', [
    tool('admin.read.clients.list', 'agent:read', ['admin:clients:read']),
  ]);

  it('defaults the configuration IDs from the grant and honours explicit pins', async () => {
    const defaults = await resolveSelfServiceAgentAccessSnapshot({ ...base, catalog });
    expect(defaults).toMatchObject({
      taskSetId: 'system_agent_task_set_grant-a',
      taskSetVersion: 1,
      scopePolicyId: 'system_agent_scope_policy_grant-a',
      scopePolicyVersion: 1,
    });
    const pinned = await resolveSelfServiceAgentAccessSnapshot({
      ...base,
      catalog,
      taskSetId: 'ats_x',
      taskSetVersion: 3,
      scopePolicyId: 'asp_x',
      scopePolicyVersion: 4,
    });
    expect(pinned).toMatchObject({
      taskSetId: 'ats_x',
      taskSetVersion: 3,
      scopePolicyId: 'asp_x',
      scopePolicyVersion: 4,
    });
  });

  it('computes the documented access snapshot hash', async () => {
    const snapshot = await resolveSelfServiceAgentAccessSnapshot({ ...base, catalog });
    const expected = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-self-service-snapshot-v1',
        tenant_id: 'tenant-a',
        admin_user_id: 'admin-a',
        client_id: 'client-a',
        grant_id: 'grant-a',
        expires_at: 1_000_000,
        scopes: ['agent:read'],
        task_set: { id: snapshot.taskSetId, version: 1, digest: snapshot.taskSetDigest },
        scope_policy: {
          id: snapshot.scopePolicyId,
          version: 1,
          digest: snapshot.scopePolicyDigest,
        },
        tools: snapshot.resolvedTools,
      } as unknown as JsonValue)
    );
    expect(snapshot.accessSnapshotHash).toBe(expected);
  });

  it.each([
    [{ adminUserId: 'admin-b' }],
    [{ taskSetId: 'ats_other' }],
    [{ taskSetVersion: 2 }],
    [{ scopePolicyId: 'asp_other' }],
    [{ scopePolicyVersion: 2 }],
    [{ authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 3 }] }],
  ])('changes the hash when %j changes', async (changed) => {
    const original = await resolveSelfServiceAgentAccessSnapshot({ ...base, catalog });
    const next = await resolveSelfServiceAgentAccessSnapshot({ ...base, catalog, ...changed });
    expect(next.accessSnapshotHash).not.toBe(original.accessSnapshotHash);
  });
});
