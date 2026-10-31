import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';

const mocks = vi.hoisted(() => ({
  createSnapshot: vi.fn((input: unknown) => input),
}));

vi.mock('../tenant-backup-record-snapshot-port', () => ({
  createEncryptedTenantBackupRecordSnapshotPort: mocks.createSnapshot,
}));

import { createTenantBackupLogicalPlacementPorts } from '../tenant-backup-logical-placement-port';

function context(roles: string[] = ['tenant_core', 'tenant_pii']): AdapterContext {
  return {
    context: {
      lease: { tenantId: 'tenant-a' },
      signal: new AbortController().signal,
    },
    databases: {
      tenant: [
        {
          assignments: roles.map((role) => ({ role })),
        },
      ],
      fixed: [{ binding: 'DB_ADMIN' }],
    },
  } as unknown as AdapterContext;
}

describe('tenant backup logical placement production port', () => {
  it('captures logical roles and rebuild contracts without physical identifiers', async () => {
    createTenantBackupLogicalPlacementPorts({} as Env);
    const input = mocks.createSnapshot.mock.calls[0][0] as {
      assertSource(context: AdapterContext): Promise<void>;
      capture(context: AdapterContext): AsyncIterable<Uint8Array>;
    };
    await expect(input.assertSource(context())).resolves.toBeUndefined();
    const rows: Uint8Array[] = [];
    for await (const row of input.capture(context())) rows.push(row);
    const encoded = new TextDecoder().decode(rows[0]);
    expect(encoded).toContain('tenant_core');
    expect(encoded).toContain('tenant_pii');
    expect(encoded).toContain('lookup-routing');
    expect(encoded).not.toMatch(/databaseId|bucketName|namespaceId|bindingRef/);
  });

  it('rejects incomplete source inventory and unsupported target plans', async () => {
    const ports = createTenantBackupLogicalPlacementPorts({} as Env);
    const input = mocks.createSnapshot.mock.calls.at(-1)?.[0] as {
      assertSource(context: AdapterContext): Promise<void>;
    };
    await expect(input.assertSource(context(['tenant_core']))).rejects.toThrow(
      'backup_logical_placement_invalid'
    );
    await expect(
      ports.prepareLogicalTarget(
        { signal: new AbortController().signal },
        {
          version: 1,
          databaseRoles: ['tenant_core'],
          rebuild: [],
          externalPrerequisiteIds: [],
        }
      )
    ).rejects.toThrow('backup_logical_placement_invalid');
  });

  it('accepts the installed target contract during prepare and verification', async () => {
    const ports = createTenantBackupLogicalPlacementPorts({} as Env);
    const target = {
      version: 1 as const,
      databaseRoles: ['admin', 'tenant_core', 'tenant_pii'],
      rebuild: ['lookup-routing', 'plugin-runner-runtime', 'session-revocation'],
      externalPrerequisiteIds: [],
    };
    await expect(
      ports.prepareLogicalTarget({ signal: new AbortController().signal }, target)
    ).resolves.toBeUndefined();
    await expect(
      ports.verifyLogicalTarget({ signal: new AbortController().signal }, target)
    ).resolves.toBe(true);
  });
});
