import { readMigrationSource } from '../../../../test/helpers/migration-source.mjs';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateAuditLog = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuditLog: mockCreateAuditLog,
}));

import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  GuestLifecycleRepository,
  createGuestDeletionProgress,
  guestErasureBoundaryId,
  type GuestDeletionReceiptV2,
} from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { openCoreStore } from './helpers/core-schema-sqlite';
import {
  createGuestDeletionAuditTaskFromContext,
  GuestDeletionAuditOutboxRepository,
  processGuestDeletionAuditOutbox,
} from '../guest-deletion-audit-outbox';

describe('guest deletion audit reconciliation outbox', () => {
  const deletionRouteJson = '{"schemaVersion":1}';
  let db: SQLiteDatabase;
  let adapter: DatabaseAdapter;

  beforeEach(async () => {
    mockCreateAuditLog.mockReset().mockResolvedValue(undefined);
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
      readMigrationSource(
        new URL('../../../../migrations/core/d1/', import.meta.url),
        '002_guest_account_lifecycle.sql'
      )
    );
    db.exec(
      readMigrationSource(
        new URL('../../../../migrations/core/d1/', import.meta.url),
        '004_guest_deletion_audit_outbox.sql'
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

  it('runs lifecycle recovery before scheduled completion-audit reconciliation', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const maintenanceBlock = source.slice(source.indexOf('const maintenancePage'));
    expect(maintenanceBlock.indexOf('processGuestLifecycleMaintenance(')).toBeLessThan(
      maintenanceBlock.indexOf('processGuestDeletionAuditOutbox(')
    );
  });

  it('persists the request and proxy metadata used by immediate audit delivery', () => {
    const headers: Record<string, string> = {
      'CF-Connecting-IP': '192.0.2.1',
      'User-Agent': 'test-agent',
      'X-Request-Id': 'proxy-request',
      'X-Correlation-Id': 'correlation-1',
      'X-Authrim-Admin-UI-Api-Mode': 'bff',
      'X-Authrim-Forwarded-Host': 'admin.example.com',
      'X-Forwarded-Proto': 'https',
    };
    const task = createGuestDeletionAuditTaskFromContext(
      {
        get: (name: string) =>
          name === 'adminAuth'
            ? { userId: 'admin-1' }
            : name === 'requestId'
              ? 'context-request'
              : undefined,
        req: { header: (name: string) => headers[name] },
      } as never,
      {
        auditId: 'audit-1',
        userId: 'guest-1',
        operationId: 'operation-1',
        metadata: { reason: 'admin_action' },
      }
    );

    expect(JSON.parse(task.metadataJson)).toEqual({
      reason: 'admin_action',
      request_id: 'context-request',
      admin_ui_api_mode: 'bff',
      admin_ui_bff_forwarded_host: 'admin.example.com',
      admin_ui_bff_forwarded_proto: 'https',
      admin_ui_bff_request_id: 'proxy-request',
      admin_ui_bff_correlation_id: 'correlation-1',
    });
  });

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
      createdAt: 900,
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
        writeAudit: async (task, _adapter, completedAt) => {
          await mockCreateAuditLog({} as Env, {
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
            createdAt: completedAt,
          });
        },
      }
    );

    expect(summary).toEqual({ processed: 1, succeeded: 1, retrying: 0 });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        id: 'account-guest-deleted-operation-1',
        action: 'user.deleted',
        userId: 'admin-1',
        createdAt: 1_000_000,
      })
    );
    expect(
      await adapter.queryOne('SELECT id FROM audit_log WHERE id = ?', [
        'account-guest-deleted-operation-1',
      ])
    ).toBeNull();
    expect(await restartedRepository.get('account-guest-deleted-operation-1')).toBeNull();
  });

  it('drains more than one due page during the same maintenance visit', async () => {
    const lifecycle = new GuestLifecycleRepository(adapter, 'tenant-a');
    const repository = new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a');
    for (let index = 0; index < 21; index += 1) {
      const userId = `guest-bulk-${index}`;
      const operationId = `operation-bulk-${index}`;
      await adapter.execute(
        `INSERT INTO identity_accounts
           (tenant_id, legacy_user_id, account_type, registration_state, deleted_at)
         VALUES (?, ?, 'user', 'guest', NULL)`,
        ['tenant-a', userId]
      );
      await lifecycle.enroll({
        userId,
        clientId: 'client-1',
        createdAt: 100,
        deletionAfterDays: null,
        policyVersion: 'policy-1',
      });
      expect(
        await lifecycle.beginAdministrativeDeletion(
          userId,
          operationId,
          999,
          deletionRouteJson,
          999000
        )
      ).toBe(true);
      expect(await lifecycle.completeDeletion(userId, operationId, 1000)).toBe(true);
      await repository.enqueue({
        auditId: `account-guest-deleted-${operationId}`,
        userId,
        operationId,
        actorUserId: 'admin-1',
        ipAddress: 'unknown',
        userAgent: 'unknown',
        metadataJson: '{}',
        createdAt: 900,
      });
    }
    const writeAudit = vi.fn().mockResolvedValue(undefined);

    expect(
      await processGuestDeletionAuditOutbox(
        {} as Env,
        [{ tenantId: 'tenant-a', adapters: [{ adapter, bindingRef: 'CORE' }] }],
        { info: vi.fn(), warn: vi.fn() },
        { now: () => 1001, nowMs: () => 0, deadlineMs: 1, writeAudit }
      )
    ).toEqual({ processed: 21, succeeded: 21, retrying: 0 });
    expect(writeAudit).toHaveBeenCalledTimes(21);
    expect(await repository.listDue(1001, 100)).toEqual([]);
  });

  it('rotates the first adapter after a shared deadline is exhausted', async () => {
    const lifecycleA = new GuestLifecycleRepository(adapter, 'tenant-a');
    expect(
      await lifecycleA.beginAdministrativeDeletion(
        'guest-1',
        'operation-a',
        999,
        deletionRouteJson,
        999000
      )
    ).toBe(true);
    expect(await lifecycleA.completeDeletion('guest-1', 'operation-a', 1000)).toBe(true);
    await new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a').enqueue({
      auditId: 'account-guest-deleted-operation-a',
      userId: 'guest-1',
      operationId: 'operation-a',
      actorUserId: 'admin-1',
      ipAddress: 'unknown',
      userAgent: 'unknown',
      metadataJson: '{}',
      createdAt: 900,
    });
    await adapter.execute(
      `INSERT INTO identity_accounts
         (tenant_id, legacy_user_id, account_type, registration_state, deleted_at)
       VALUES (?, ?, 'user', 'guest', NULL)`,
      ['tenant-b', 'guest-b']
    );
    const lifecycle = new GuestLifecycleRepository(adapter, 'tenant-b');
    await lifecycle.enroll({
      userId: 'guest-b',
      clientId: 'client-1',
      createdAt: 100,
      deletionAfterDays: null,
      policyVersion: 'policy-1',
    });
    expect(
      await lifecycle.beginAdministrativeDeletion(
        'guest-b',
        'operation-b',
        999,
        deletionRouteJson,
        999000
      )
    ).toBe(true);
    expect(await lifecycle.completeDeletion('guest-b', 'operation-b', 1000)).toBe(true);
    await new GuestDeletionAuditOutboxRepository(adapter, 'tenant-b').enqueue({
      auditId: 'account-guest-deleted-operation-b',
      userId: 'guest-b',
      operationId: 'operation-b',
      actorUserId: 'admin-1',
      ipAddress: 'unknown',
      userAgent: 'unknown',
      metadataJson: '{}',
      createdAt: 900,
    });
    const nowMs = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValue(5000);
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    let cursor: string | null = null;
    const env = {
      AUTHRIM_CONFIG: {
        get: vi.fn(async () => cursor),
        put: vi.fn(async (_key: string, value: string) => {
          cursor = value;
        }),
      },
    } as unknown as Env;
    const targets = [
      { tenantId: 'tenant-a', adapters: [{ adapter, bindingRef: 'CORE_A' }] },
      { tenantId: 'tenant-b', adapters: [{ adapter, bindingRef: 'CORE_B' }] },
    ];

    expect(
      await processGuestDeletionAuditOutbox(
        env,
        targets,
        { info: vi.fn(), warn: vi.fn() },
        {
          now: () => 1001,
          nowMs,
          writeAudit,
        }
      )
    ).toEqual({ processed: 1, succeeded: 1, retrying: 0 });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(
      await new GuestDeletionAuditOutboxRepository(adapter, 'tenant-b').get(
        'account-guest-deleted-operation-b'
      )
    ).not.toBeNull();

    expect(
      await processGuestDeletionAuditOutbox(
        env,
        targets,
        { info: vi.fn(), warn: vi.fn() },
        {
          now: () => 1001,
          nowMs: () => 0,
          deadlineMs: 1,
          writeAudit,
        }
      )
    ).toEqual({ processed: 1, succeeded: 1, retrying: 0 });
    expect(writeAudit).toHaveBeenCalledTimes(2);
    expect(writeAudit.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ tenant_id: 'tenant-b' })
    );
    expect(
      await new GuestDeletionAuditOutboxRepository(adapter, 'tenant-b').get(
        'account-guest-deleted-operation-b'
      )
    ).toBeNull();
  });

  it('uses the configured audit store rather than the identity shard during replay', async () => {
    const repository = new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a');
    await repository.enqueue({
      auditId: 'account-guest-deleted-canonical-audit',
      userId: 'guest-1',
      operationId: 'canonical-audit',
      actorUserId: 'admin-1',
      ipAddress: 'unknown',
      userAgent: 'unknown',
      metadataJson: '{}',
      createdAt: 900,
    });
    const lifecycle = new GuestLifecycleRepository(adapter, 'tenant-a');
    expect(
      await lifecycle.beginAdministrativeDeletion(
        'guest-1',
        'canonical-audit',
        999,
        deletionRouteJson,
        999000
      )
    ).toBe(true);
    expect(await lifecycle.completeDeletion('guest-1', 'canonical-audit', 1000)).toBe(true);
    const canonicalAuditDb = { prepare: vi.fn() } as unknown as D1Database;
    const env = { DB: canonicalAuditDb } as Env;

    expect(
      await processGuestDeletionAuditOutbox(
        env,
        [{ tenantId: 'tenant-a', adapters: [{ adapter, bindingRef: 'IDENTITY_SHARD' }] }],
        { info: vi.fn(), warn: vi.fn() },
        { now: () => 1001 }
      )
    ).toEqual({ processed: 1, succeeded: 1, retrying: 0 });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        id: 'account-guest-deleted-canonical-audit',
        createdAt: 1000 * 1000,
      })
    );
    expect(mockCreateAuditLog.mock.calls[0][0].DB).toBe(canonicalAuditDb);
    expect(mockCreateAuditLog.mock.calls[0][0].DB).not.toBe(adapter);
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

  it('keeps a fresh task while its lifecycle claim may still be in flight', async () => {
    const repository = new GuestDeletionAuditOutboxRepository(adapter, 'tenant-a');
    await repository.enqueue({
      auditId: 'account-guest-deleted-operation-pending',
      userId: 'guest-1',
      operationId: 'operation-pending',
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
    expect((await repository.get('account-guest-deleted-operation-pending'))?.status).toBe('retry');
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
        { now: () => 2000, writeAudit }
      )
    ).toEqual({ processed: 1, succeeded: 0, retrying: 0 });
    expect(writeAudit).not.toHaveBeenCalled();
    expect(await repository.get('account-guest-deleted-operation-stale')).toBeNull();
  });
});

// Actual fully migrated SQLite, labelled D1 for the SQL repository; native D1 is covered
// separately by the Core transport suite. Only audit delivery is substituted here.
describe('Guest v2 terminal audit and acknowledgement gate', () => {
  const opened: SQLiteDatabase[] = [];
  afterEach(() => opened.splice(0).forEach((db) => db.close()));
  async function fixture() {
    const { db, adapter: base } = openCoreStore('tenant-v2');
    opened.push(db);
    db.exec('PRAGMA foreign_keys=ON');
    const adapter: DatabaseAdapter = { ...base, getType: () => 'd1' };
    const userId = '10000000-0000-4000-8000-000000000001';
    const accountId = '20000000-0000-4000-8000-000000000001';
    const accepted: GuestDeletionReceiptV2 = {
      schemaVersion: 2,
      tenantId: 'tenant-v2',
      userId,
      accountId,
      operationId: 'guest-deletion-fixed',
      accountRouteGeneration: 1,
      corePin: {
        databaseId: 'physical-core',
        bindingRef: 'CORE_A',
        dataRole: 'tenant_core/users',
        residencyPartition: 'region-a',
        shardId: 'core-a',
        assignmentGeneration: 1,
        bindingRouteGeneration: 1,
      },
      piiPin: {
        databaseId: 'physical-pii',
        bindingRef: 'PII_A',
        dataRole: 'tenant_pii',
        residencyPartition: 'region-a',
        shardId: 'pii-a',
        assignmentGeneration: 1,
        bindingRouteGeneration: 1,
      },
      routeProjection: {
        schemaVersion: 1,
        accountRouteGeneration: 1,
        residencyPolicyId: 'fixture-policy',
        targets: [
          {
            dataRole: 'tenant_core/users',
            residencyPartition: 'region-a',
            shardId: 'core-a',
            bindingRef: 'CORE_A',
            requiredBindingRouteGeneration: 1,
          },
          {
            dataRole: 'tenant_pii',
            residencyPartition: 'region-a',
            shardId: 'pii-a',
            bindingRef: 'PII_A',
            requiredBindingRouteGeneration: 1,
          },
        ],
      },
      completionAuditMode: 'outbox',
      completionAuditId: 'audit-v2',
      origin: 'admin',
      execution: { phase: 'accepted', boundaryId: null, erasureStartedAtMs: null },
    };
    db.prepare(
      `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,created_at,updated_at) VALUES(?,?,'user','active',?,'guest','active',100,100)`
    ).run(accountId, accepted.tenantId, userId);
    const lifecycle = new GuestLifecycleRepository(adapter, accepted.tenantId);
    await lifecycle.enroll({
      userId,
      clientId: 'app',
      createdAt: 100,
      deletionAfterDays: null,
      policyVersion: 'policy:1',
    });
    const metadata = JSON.stringify({
      guestDeletionVersion: 2,
      operationId: accepted.operationId,
      registration_state: 'guest',
      reason: 'admin_action',
    });
    await lifecycle.admitDeletion({
      userId,
      accountId,
      operationId: accepted.operationId,
      routeJson: JSON.stringify(accepted),
      expectedRevision: 1,
      accountRouteGeneration: 1,
      now: 1000,
      startedAtMs: 1000000,
      origin: 'admin',
      task: {
        auditId: accepted.completionAuditId,
        actorUserId: 'original-admin',
        ipAddress: '192.0.2.1',
        userAgent: 'original-agent',
        metadataJson: metadata,
        createdAt: 1000,
      },
    });
    const route = {
      ...accepted,
      execution: {
        phase: 'erasure_started' as const,
        boundaryId: await guestErasureBoundaryId(accepted.operationId),
        erasureStartedAtMs: 1000001,
      },
    };
    const routeJson = JSON.stringify(route);
    await lifecycle.confirmErasureStart({
      userId,
      accountId,
      operationId: route.operationId,
      expectedRevision: 2,
      acceptedRouteJson: JSON.stringify(accepted),
      erasureStartedRouteJson: routeJson,
      accountRouteGeneration: 1,
      now: 1001,
    });
    const progress = {
      ...(await createGuestDeletionProgress(route, [1])),
      stage: 'final_core' as const,
    };
    db.prepare('UPDATE guest_deletion_audit_outbox SET execution_progress_json=?').run(
      JSON.stringify(progress)
    );
    const next = {
      ...progress,
      revision: progress.revision + 2,
      stage: 'directory_ready' as const,
    };
    expect(
      await lifecycle.finishCoreErasure({
        routeJson,
        userId,
        expectedProgressJson: JSON.stringify(progress),
        nextProgressJson: JSON.stringify(next),
        now: 1002,
      })
    ).toBe(true);
    const repository = new GuestDeletionAuditOutboxRepository(adapter, accepted.tenantId);
    const stage = (value: 'compact_pii' | 'terminal') =>
      db
        .prepare('UPDATE guest_deletion_audit_outbox SET execution_progress_json=?')
        .run(JSON.stringify({ ...next, revision: next.revision + 1, stage: value }));
    const process = (
      writeAudit: NonNullable<Parameters<typeof processGuestDeletionAuditOutbox>[3]>['writeAudit'],
      now = 2000
    ) =>
      processGuestDeletionAuditOutbox(
        {} as Env,
        [{ tenantId: accepted.tenantId, adapters: [{ adapter, bindingRef: 'CORE_A' }] }],
        { info: vi.fn(), warn: vi.fn() },
        { now: () => now, nowMs: () => 0, deadlineMs: 1, writeAudit }
      );
    return { db, adapter, repository, route, metadata, stage, process };
  }
  it('preserves a Core-terminal task until PII compaction has reached terminal progress', async () => {
    const f = await fixture();
    f.stage('compact_pii');
    const writeAudit = vi.fn();
    expect(await f.process(writeAudit)).toEqual({ processed: 1, succeeded: 0, retrying: 1 });
    expect(writeAudit).not.toHaveBeenCalled();
    expect(await f.repository.get(f.route.completionAuditId)).toEqual(
      expect.objectContaining({
        actor_user_id: 'original-admin',
        ip_address: '192.0.2.1',
        metadata_json: f.metadata,
        status: 'retry',
      })
    );
  });
  it('retries delivery with original task identity and deletes the full task after durable success', async () => {
    const f = await fixture();
    f.stage('terminal');
    const delivery = vi
      .fn()
      .mockRejectedValueOnce(new Error('delivery_failed'))
      .mockResolvedValue(undefined);
    expect(await f.process(delivery)).toEqual({ processed: 1, succeeded: 0, retrying: 1 });
    expect(await f.repository.get(f.route.completionAuditId)).not.toBeNull();
    expect(await f.process(delivery, 3000)).toEqual({ processed: 1, succeeded: 1, retrying: 0 });
    expect(delivery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audit_id: f.route.completionAuditId,
        actor_user_id: 'original-admin',
        ip_address: '192.0.2.1',
        user_agent: 'original-agent',
        metadata_json: f.metadata,
        created_at: 1000,
      }),
      f.adapter,
      1002000
    );
    expect(await f.repository.get(f.route.completionAuditId)).toBeNull();
    expect(f.db.prepare('SELECT * FROM guest_deletion_audit_outbox').all()).toEqual([]);
  });
  it('confirms an acknowledgement lost after the actual DELETE from primary absence and terminal evidence', async () => {
    const f = await fixture();
    f.stage('terminal');
    const execute = f.adapter.execute.bind(f.adapter);
    f.adapter.execute = vi.fn(async (sql: string, params?: unknown[]) => {
      await execute(sql, params);
      throw new Error('lost_delete_ack');
    });
    await expect(f.repository.markSucceeded(f.route.completionAuditId)).resolves.toBeUndefined();
    expect(await f.repository.get(f.route.completionAuditId)).toBeNull();
  });
  it('retains the original task when the acknowledgement did not commit', async () => {
    const f = await fixture();
    f.stage('terminal');
    const before = await f.repository.get(f.route.completionAuditId);
    f.adapter.execute = vi.fn().mockRejectedValue(new Error('delete_unavailable'));
    await expect(f.repository.markSucceeded(f.route.completionAuditId)).rejects.toThrow(
      'guest_deletion_audit_ack_unknown'
    );
    expect(await f.repository.get(f.route.completionAuditId)).toEqual(before);
  });
  it('refuses a stale task whose request metadata was replaced after it was read', async () => {
    const f = await fixture();
    f.stage('terminal');
    const task = await f.repository.get(f.route.completionAuditId);
    if (!task) throw new Error('fixture_task_missing');
    f.db.prepare("UPDATE guest_deletion_audit_outbox SET ip_address='192.0.2.2'").run();
    await expect(f.repository.acknowledgeV2(task)).rejects.toThrow(
      'guest_deletion_audit_ack_unknown'
    );
    expect(await f.repository.get(f.route.completionAuditId)).toEqual(
      expect.objectContaining({ ip_address: '192.0.2.2' })
    );
  });
  it('never treats a v2 receipt as a legacy acknowledgement after the metadata version was removed', async () => {
    const f = await fixture();
    f.stage('terminal');
    f.db.prepare("UPDATE guest_deletion_audit_outbox SET metadata_json='{}'").run();
    await expect(f.repository.markSucceeded(f.route.completionAuditId)).rejects.toThrow();
    expect(await f.repository.get(f.route.completionAuditId)).not.toBeNull();
  });
});
