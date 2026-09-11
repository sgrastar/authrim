import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { GuestLifecycleRepository, writeLegacyAuditLog } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import {
  GuestDeletionAuditOutboxRepository,
  processGuestDeletionAuditOutbox,
} from '../guest-deletion-audit-outbox';

describe('guest deletion audit reconciliation outbox', () => {
  const deletionRouteJson = '{"schemaVersion":1}';
  let db: SQLiteDatabase;
  let adapter: DatabaseAdapter;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE identity_accounts (
        tenant_id TEXT NOT NULL,
        legacy_user_id TEXT NOT NULL,
        account_type TEXT NOT NULL,
        registration_state TEXT NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata_json TEXT,
        severity TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO identity_accounts
        VALUES ('tenant-a', 'guest-1', 'user', 'guest', NULL);
    `);
    db.exec(
      readFileSync(
        new URL('../../../../migrations/core/d1/002_guest_account_lifecycle.sql', import.meta.url),
        'utf8'
      )
    );
    db.exec(
      readFileSync(
        new URL(
          '../../../../migrations/core/d1/004_guest_deletion_audit_outbox.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    adapter = {
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return (db.prepare(sql).get(...(params as SQLInputValue[])) ?? null) as T | null;
      },
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
      async execute(sql: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
        };
      },
    } as DatabaseAdapter;
    await new GuestLifecycleRepository(adapter, 'tenant-a').enroll({
      userId: 'guest-1',
      clientId: 'client-1',
      createdAt: 100,
      deletionAfterDays: null,
      policyVersion: 'policy-1',
    });
  });

  afterEach(() => db.close());

  it('survives a processor restart and persists the missing completion audit', async () => {
    const repository = new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a');
    await repository.enqueue({
      auditId: 'account-guest-deleted-operation-1',
      userId: 'guest-1',
      operationId: 'operation-1',
      actorUserId: 'admin-1',
      ipAddress: '192.0.2.1',
      userAgent: 'test-agent',
      metadataJson: JSON.stringify({
        operationId: 'operation-1',
        registration_state: 'guest',
        reason: 'manual_cleanup',
        source: 'guest_cleanup_api',
      }),
      createdAt: 1000,
    });
    const lifecycle = new GuestLifecycleRepository(adapter, 'tenant-a');
    expect(
      await lifecycle.beginAdministrativeDeletion(
        'guest-1',
        'operation-1',
        999,
        deletionRouteJson,
        999000
      )
    ).toBe(true);
    await adapter.execute(
      'UPDATE identity_accounts SET deleted_at = ? WHERE tenant_id = ? AND legacy_user_id = ?',
      [999, 'tenant-a', 'guest-1']
    );
    expect(await lifecycle.completeDeletion('guest-1', 'operation-1', 1000)).toBe(true);

    expect(await repository.listDue(1000, 10)).toHaveLength(1);

    const restartedRepository = new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a');
    const summary = await processGuestDeletionAuditOutbox(
      {} as Env,
      [{ tenantId: 'tenant-a', adapters: [{ adapter, bindingRef: 'CORE' }] }],
      { info: vi.fn(), warn: vi.fn() },
      {
        now: () => 1001,
        writeAudit: async (task) => {
          await writeLegacyAuditLog(adapter, {
            id: task.audit_id,
            tenantId: task.tenant_id,
            userId: task.actor_user_id,
            action: 'user.deleted',
            resource: 'user',
            resourceId: task.user_id,
            ipAddress: task.ip_address,
            userAgent: task.user_agent,
            metadata: task.metadata_json,
            severity: 'info',
            createdAt: Number(task.created_at),
          });
        },
      }
    );

    expect(summary).toEqual({ processed: 1, succeeded: 1, retrying: 0 });
    expect(
      await adapter.queryOne<{ action: string; user_id: string }>(
        'SELECT action, user_id FROM audit_log WHERE id = ?',
        ['account-guest-deleted-operation-1']
      )
    ).toEqual({ action: 'user.deleted', user_id: 'admin-1' });
    expect((await restartedRepository.get('account-guest-deleted-operation-1'))?.status).toBe(
      'succeeded'
    );
  });

  it('does not emit completion before the account deletion is committed', async () => {
    expect(
      await new GuestLifecycleRepository(adapter, 'tenant-a').beginAdministrativeDeletion(
        'guest-1',
        'operation-2',
        999,
        deletionRouteJson
      )
    ).toBe(true);
    const repository = new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a');
    await repository.enqueue({
      auditId: 'account-guest-deleted-operation-2',
      userId: 'guest-1',
      operationId: 'operation-2',
      actorUserId: 'admin-1',
      ipAddress: 'unknown',
      userAgent: 'unknown',
      metadataJson: '{}',
      createdAt: 1000,
    });
    const writeAudit = vi.fn();

    expect(
      await processGuestDeletionAuditOutbox(
        {} as Env,
        [{ tenantId: 'tenant-a', adapters: [{ adapter, bindingRef: 'CORE' }] }],
        { info: vi.fn(), warn: vi.fn() },
        { now: () => 1001, writeAudit }
      )
    ).toEqual({ processed: 1, succeeded: 0, retrying: 1 });
    expect(writeAudit).not.toHaveBeenCalled();
    expect((await repository.get('account-guest-deleted-operation-2'))?.status).toBe('retry');
  });

  it('does not emit completion for a different deletion operation', async () => {
    const lifecycle = new GuestLifecycleRepository(adapter, 'tenant-a');
    expect(
      await lifecycle.beginAdministrativeDeletion(
        'guest-1',
        'operation-1',
        999,
        deletionRouteJson,
        999000
      )
    ).toBe(true);
    expect(await lifecycle.completeDeletion('guest-1', 'operation-1', 1000)).toBe(true);
    const repository = new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a');
    await repository.enqueue({
      auditId: 'account-guest-deleted-operation-stale',
      userId: 'guest-1',
      operationId: 'operation-stale',
      actorUserId: 'admin-1',
      ipAddress: 'unknown',
      userAgent: 'unknown',
      metadataJson: '{}',
      createdAt: 1000,
    });
    const writeAudit = vi.fn();

    expect(
      await processGuestDeletionAuditOutbox(
        {} as Env,
        [{ tenantId: 'tenant-a', adapters: [{ adapter, bindingRef: 'CORE' }] }],
        { info: vi.fn(), warn: vi.fn() },
        { now: () => 1001, writeAudit }
      )
    ).toEqual({ processed: 1, succeeded: 0, retrying: 1 });
    expect(writeAudit).not.toHaveBeenCalled();
    expect((await repository.get('account-guest-deleted-operation-stale'))?.status).toBe('retry');
  });
});
