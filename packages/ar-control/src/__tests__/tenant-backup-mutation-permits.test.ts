import { createTenantBackupBoundaryRpcClient } from '@authrim/ar-lib-core/services/tenant-portability/boundary-rpc-client';
import { startTenantBackupSnapshotBoundary } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary';
import { controlTenantBackupBoundary } from '../tenant-backup-boundary';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { ControlEnv } from '../types';
import { controlTenantMutationPermit } from '../tenant-backup-mutation-permits';

it('scopes permits to the authenticated environment, tenant and caller and permits completion after metadata changes', async () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(
      readFileSync(
        new URL(
          '../../../../migrations/control/d1/005_tenant_backup_mutation_admission.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    sql.exec(
      readFileSync(
        new URL(
          '../../../../migrations/control/d1/006_tenant_backup_mutation_environment_scope.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    sql.exec(
      readFileSync(
        new URL(
          '../../../../migrations/control/d1/007_tenant_backup_boundary_receipts.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    sql.exec(
      readFileSync(
        new URL(
          '../../../../migrations/control/d1/010_tenant_backup_snapshot_timestamp.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    sql.exec(
      "CREATE TABLE control_tenant_placement_policies(environment_id TEXT,tenant_id TEXT); INSERT INTO control_tenant_placement_policies VALUES ('env-a','tenant'),('env-b','tenant')"
    );
    const database = {
      prepare(statement: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async first<T>() {
                return (sql.prepare(statement).get(...(params as SQLInputValue[])) as T) ?? null;
              },
              async run() {
                return {
                  success: true,
                  meta: {
                    changes: Number(
                      sql.prepare(statement).run(...(params as SQLInputValue[])).changes
                    ),
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as ControlEnv['CONTROL_DB'];
    const input = {
      database,
      environmentId: 'env-a',
      caller: 'ar-management',
      request: { tenantId: 'tenant', permitId: crypto.randomUUID() },
      now: 100,
    };
    expect(await controlTenantMutationPermit({ ...input, action: 'acquire' })).toEqual({
      admitted: true,
    });
    expect(
      await controlTenantMutationPermit({ ...input, environmentId: 'env-b', action: 'acquire' })
    ).toEqual({ admitted: true });
    await expect(
      controlTenantMutationPermit({ ...input, environmentId: 'unknown', action: 'acquire' })
    ).rejects.toThrow('invalid_backup_mutation_tenant');
    await controlTenantMutationPermit({ ...input, caller: 'another-worker', action: 'complete' });
    expect(
      sql
        .prepare('SELECT count(*) n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL')
        .get()?.n
    ).toBe(2);
    sql.exec("DELETE FROM control_tenant_placement_policies WHERE environment_id='env-a'");
    await controlTenantMutationPermit({ ...input, action: 'complete', now: 101 });
    expect(
      sql
        .prepare('SELECT count(*) n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL')
        .get()?.n
    ).toBe(1);
    await controlTenantMutationPermit({
      ...input,
      environmentId: 'env-b',
      action: 'complete',
      now: 102,
    });
    expect(
      sql
        .prepare('SELECT count(*) n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL')
        .get()?.n
    ).toBe(0);
    const sharedRequest = {
      ...input,
      scope: 'environment' as const,
      request: { permitId: crypto.randomUUID() },
    };
    expect(await controlTenantMutationPermit({ ...sharedRequest, action: 'acquire' })).toEqual({
      admitted: true,
    });
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM tenant_backup_mutation_permits WHERE environment_id='env-a' AND scope='environment' AND completed_at IS NULL"
        )
        .get()?.n
    ).toBe(1);
    await expect(
      controlTenantMutationPermit({
        ...sharedRequest,
        action: 'acquire',
        request: { ...sharedRequest.request, tenantId: 'tenant' },
      })
    ).rejects.toThrow('invalid_backup_mutation_permit');
    await controlTenantMutationPermit({
      ...sharedRequest,
      caller: 'another-worker',
      action: 'complete',
    });
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM tenant_backup_mutation_permits WHERE scope='environment' AND completed_at IS NULL"
        )
        .get()?.n
    ).toBe(1);
    await controlTenantMutationPermit({ ...sharedRequest, action: 'complete' });
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM tenant_backup_mutation_permits WHERE scope='environment' AND completed_at IS NULL"
        )
        .get()?.n
    ).toBe(0);
    sql.exec("INSERT INTO control_tenant_placement_policies VALUES ('env-a','tenant')");
    const boundary = {
      tenantId: 'tenant',
      operationId: 'backup',
      boundaryId: 'ab'.repeat(32),
      inventoryDigest: 'cd'.repeat(32),
    };
    const physical = [
      { resourceId: 'core', snapshotId: 'core-snapshot' },
      { resourceId: 'pii', snapshotId: 'pii-snapshot' },
    ];
    const rpc = { database, environmentId: 'env-a', caller: 'ar-management', now: 120 };
    const writerInput = {
      ...input,
      request: { tenantId: 'tenant', permitId: crypto.randomUUID() },
      now: 119,
    };
    await controlTenantMutationPermit({ ...writerInput, action: 'acquire' });
    expect(
      (await controlTenantBackupBoundary({ ...rpc, request: { ...boundary, action: 'begin' } }))
        .boundary?.id
    ).toBe(boundary.boundaryId);
    expect(
      (
        await controlTenantBackupBoundary({
          ...rpc,
          request: { ...boundary, action: 'plan', participants: physical },
        })
      ).accepted
    ).toBe(true);
    expect(
      (await controlTenantBackupBoundary({ ...rpc, request: { ...boundary, action: 'hold' } }))
        .boundary
    ).toBeNull();
    await controlTenantMutationPermit({ ...writerInput, action: 'complete', now: 121 });
    expect(
      (
        await controlTenantBackupBoundary({
          ...rpc,
          now: 122,
          request: { ...boundary, action: 'hold' },
        })
      ).boundary?.state
    ).toBe('held');
    expect(
      await controlTenantMutationPermit({
        ...writerInput,
        action: 'acquire',
        request: { tenantId: 'tenant', permitId: crypto.randomUUID() },
        now: 123,
      })
    ).toEqual({ admitted: false });
    await controlTenantBackupBoundary({
      ...rpc,
      request: { ...boundary, action: 'abort', operationId: 'other' },
    });
    await controlTenantBackupBoundary({
      ...rpc,
      caller: 'other-worker',
      request: { ...boundary, action: 'abort' },
    });
    expect(
      (
        await controlTenantBackupBoundary({
          ...rpc,
          environmentId: 'env-b',
          request: { ...boundary, action: 'begin' },
        })
      ).boundary?.state
    ).toBe('draining');
    expect(
      (
        await controlTenantBackupBoundary({
          ...rpc,
          request: { ...boundary, action: 'assertHeld' },
        })
      ).accepted
    ).toBe(true);
    expect(
      (await controlTenantBackupBoundary({ ...rpc, request: { ...boundary, action: 'release' } }))
        .boundary
    ).toBeNull();
    for (const p of physical)
      expect(
        (
          await controlTenantBackupBoundary({
            ...rpc,
            now: 124,
            request: { ...boundary, action: 'acknowledge', participant: p },
          })
        ).accepted
      ).toBe(true);
    expect(
      (
        await controlTenantBackupBoundary({
          ...rpc,
          now: 125,
          request: { ...boundary, action: 'release' },
        })
      ).boundary?.released_at
    ).toBe(125);
    expect(
      (
        await controlTenantBackupBoundary({
          ...rpc,
          now: 9999,
          request: { ...boundary, action: 'readReleased', participants: physical },
        })
      ).boundary?.released_at
    ).toBe(125);
    expect(
      (
        await controlTenantBackupBoundary({
          ...rpc,
          environmentId: 'env-b',
          now: 126,
          request: { ...boundary, action: 'release' },
        })
      ).boundary
    ).toBeNull();
    for (const extra of [{ environmentId: 'forged' }, { now: 0 }, { caller: 'forged' }])
      await expect(
        controlTenantBackupBoundary({ ...rpc, request: { ...boundary, action: 'begin', ...extra } })
      ).rejects.toThrow('invalid_backup_boundary_request');
    const clientScope = {
      environmentId: 'env-a',
      tenantId: 'tenant',
      operationId: 'client-backup',
      inventoryDigest: boundary.inventoryDigest,
    };
    const client = createTenantBackupBoundaryRpcClient(
      {
        async tenantBackupSnapshotBoundary(request) {
          expect(request).not.toHaveProperty('now');
          expect(request).not.toHaveProperty('environmentId');
          return controlTenantBackupBoundary({ ...rpc, now: 1000, request });
        },
      },
      clientScope
    );
    const clientIdentity = { ...clientScope, boundaryId: 'ef'.repeat(32) };
    let startCount = 0;
    const clientInput = {
      ...client,
      identity: clientIdentity,
      signal: new AbortController().signal,
      now: () => 1000,
      async assertReady() {},
      participants: physical.map((p) => ({
        ...p,
        async start(assertHeld: () => Promise<void>) {
          await assertHeld();
          startCount++;
        },
      })),
    };
    expect((await startTenantBackupSnapshotBoundary(clientInput)).state).toBe('released');
    expect((await startTenantBackupSnapshotBoundary(clientInput)).state).toBe('released');
    expect(startCount).toBe(2);
  } finally {
    sql.close();
  }
});
