import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult } from '../../db';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import {
  appendDirectoryAuthMigrationTransactionEvent,
  cleanupExpiredDirectoryAuthEvidenceExports,
  cleanupExpiredDirectoryAuthMaintenance,
  cleanupExpiredDirectoryAuthMigrationTransactions,
  cleanupExpiredDirectoryAuthSupportBundles,
  completeDirectoryAuthEmailCodeFallback,
  completeDirectoryAuthPasskeyEnrollment,
  createDirectoryAuthMigrationTransaction,
  getActiveDirectoryAuthMigrationTransaction,
  markDirectoryAuthEvidenceExportDeleted,
  markDirectoryAuthMigrationUserEnrolled,
  markDirectoryAuthSupportBundleDeleted,
} from '../directory-auth';

vi.mock('../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn(async () => ({})) }));

interface Handlers {
  query?: (sql: string, params: unknown[]) => unknown[];
  queryOne?: (sql: string, params: unknown[]) => unknown;
  execute?: (sql: string, params: unknown[]) => ExecuteResult | Promise<ExecuteResult>;
}

function makeAdapter(handlers: Handlers = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.query ? handlers.query(sql, params) : []
  );
  const queryOne = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.queryOne ? handlers.queryOne(sql, params) : null
  );
  const execute = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.execute ? handlers.execute(sql, params) : { rowsAffected: 1, success: true }
  );
  const adapter = { query, queryOne, execute } as unknown as DatabaseAdapter;
  return { adapter, query, queryOne, execute };
}

const env = { TAG: 'env' } as never;

interface EmittedLog {
  tenantId: string;
  sourceDataset: string;
  logType: string;
  eventAt: number;
  expiresAt: number | null;
  overview: Record<string, unknown>;
  row: Record<string, unknown>;
}

function emittedLog(index = 0): EmittedLog {
  return vi.mocked(emitLogIcebergRow).mock.calls[index][1] as unknown as EmittedLog;
}

beforeEach(() => {
  vi.mocked(emitLogIcebergRow).mockClear();
});

describe('migration transactions', () => {
  it('stores the interaction id column only when present', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthMigrationTransaction(env, h.adapter, {
      tenantId: 'tenant-a',
      tokenHash: 'hash',
      scope: 'recovery',
      ttlSeconds: 600,
      connectorId: 'conn-1',
      directorySubject: 'sub-1',
      authorizationChallengeId: 'chal-1',
      attemptInteractionId: 'int-1',
      now: 1000,
    });
    expect(row).toMatchObject({
      tenant_id: 'tenant-a',
      campaign_id: null,
      user_id: null,
      connector_id: 'conn-1',
      directory_subject: 'sub-1',
      token_hash: 'hash',
      scope: 'recovery',
      state: 'active',
      request_id: null,
      authorization_challenge_id: 'chal-1',
      attempt_interaction_id: 'int-1',
      created_at: 1000,
      updated_at: 1000,
      expires_at: 1000 + 600_000,
      completed_at: null,
      blocked_reason: null,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('authorization_challenge_id, attempt_interaction_id,');
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(params).toStrictEqual([
      row.id,
      'tenant-a',
      null,
      null,
      'conn-1',
      'sub-1',
      'hash',
      'recovery',
      'active',
      null,
      'chal-1',
      'int-1',
      1000,
      1000,
      1000 + 600_000,
      null,
      null,
    ]);
  });

  it('omits the interaction column when there is no interaction and clamps ttl', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthMigrationTransaction(env, h.adapter, {
      tenantId: 'tenant-a',
      tokenHash: 'hash',
      scope: 'status_display',
      ttlSeconds: 10,
      campaignId: 'c1',
      userId: 'u1',
      requestId: 'r1',
      now: 1000,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).not.toContain('attempt_interaction_id');
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(params).toHaveLength(16);
    expect(row.attempt_interaction_id).toBeNull();
    expect(row.expires_at).toBe(1000 + 300_000);
    expect(row.campaign_id).toBe('c1');
    expect(row.user_id).toBe('u1');
    expect(row.request_id).toBe('r1');
    expect(vi.mocked(emitLogIcebergRow)).toHaveBeenCalledTimes(1);
    const emitEnv = vi.mocked(emitLogIcebergRow).mock.calls[0][0];
    const emitted = emittedLog();
    expect(emitEnv).toBe(env);
    expect(emitted).toMatchObject({
      tenantId: 'tenant-a',
      sourceDataset: 'core.directory_auth_migration_transaction_events',
      logType: 'normal',
      eventAt: 1000,
      expiresAt: null,
      overview: {
        action: 'created',
        request_id: 'r1',
        subject_id: 'u1',
        resource_id: row.id,
      },
      row: {
        tenant_id: 'tenant-a',
        transaction_id: row.id,
        campaign_id: 'c1',
        user_id: 'u1',
        event_type: 'created',
        event_payload_json: JSON.stringify({ scope: 'status_display', expires_at: 1000 + 300_000 }),
        request_id: 'r1',
        created_at: 1000,
      },
    });
    expect(emitted.row.id).toMatch(/^damte_/);
  });

  it('caps the ttl at 30 minutes', async () => {
    const row = await createDirectoryAuthMigrationTransaction(env, makeAdapter().adapter, {
      tenantId: 'tenant-a',
      tokenHash: 'hash',
      scope: 'passkey_enrollment',
      ttlSeconds: 99_999,
      now: 0,
    });
    expect(row.expires_at).toBe(1_800_000);
  });

  it('looks up an active transaction by tenant, id, hash, scope and unexpired time', async () => {
    const found = { id: 'damt_1' };
    const h = makeAdapter({ queryOne: () => found });
    expect(
      await getActiveDirectoryAuthMigrationTransaction(h.adapter, {
        tenantId: 'tenant-a',
        transactionId: 'damt_1',
        tokenHash: 'hash',
        scope: 'passkey_enrollment',
        now: 123,
      })
    ).toBe(found);
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).toContain("state = 'active'");
    expect(sql).toContain('expires_at > ?');
    expect(params).toStrictEqual(['tenant-a', 'damt_1', 'hash', 'passkey_enrollment', 123]);
  });

  it('defaults the lookup time to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(777);
      const h = makeAdapter();
      await getActiveDirectoryAuthMigrationTransaction(h.adapter, {
        tenantId: 't',
        transactionId: 'x',
        tokenHash: 'h',
        scope: 'recovery',
      });
      expect(h.queryOne.mock.calls[0][1][4]).toBe(777);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('completing transactions', () => {
  it('passkey enrollment returns false without side effects when no row was updated', async () => {
    for (const rowsAffected of [0, 2]) {
      const h = makeAdapter({ execute: () => ({ rowsAffected, success: true }) });
      expect(
        await completeDirectoryAuthPasskeyEnrollment(env, h.adapter, {
          tenantId: 'tenant-a',
          transactionId: 'damt_1',
          campaignId: 'c1',
          userId: 'u1',
          now: 10,
        })
      ).toBe(false);
      expect(h.execute).toHaveBeenCalledTimes(1);
    }
    expect(vi.mocked(emitLogIcebergRow)).not.toHaveBeenCalled();
  });

  it('passkey enrollment completes the transaction, enrolls the user and emits an event', async () => {
    const h = makeAdapter();
    expect(
      await completeDirectoryAuthPasskeyEnrollment(env, h.adapter, {
        tenantId: 'tenant-a',
        transactionId: 'damt_1',
        campaignId: 'c1',
        userId: 'u1',
        requestId: 'req-1',
        now: 10,
      })
    ).toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.execute.mock.calls[0][0]).toContain("state = 'completed'");
    expect(h.execute.mock.calls[0][1]).toStrictEqual([10, 10, 'tenant-a', 'damt_1', 10]);
    expect(h.execute.mock.calls[1][0]).toContain("state = 'enrolled'");
    expect(h.execute.mock.calls[1][1]).toStrictEqual([10, 10, 'tenant-a', 'c1', 'u1']);
    const emitted = emittedLog();
    expect(emitted.overview).toStrictEqual({
      action: 'passkey_enrollment.completed',
      request_id: 'req-1',
      subject_id: 'u1',
      resource_id: 'damt_1',
    });
    expect(emitted.row).toMatchObject({
      transaction_id: 'damt_1',
      campaign_id: 'c1',
      user_id: 'u1',
      event_type: 'passkey_enrollment.completed',
      event_payload_json: '{"completed_at":10}',
      request_id: 'req-1',
      created_at: 10,
    });
  });

  it('passkey enrollment without a campaign skips the user-state update', async () => {
    const h = makeAdapter();
    expect(
      await completeDirectoryAuthPasskeyEnrollment(env, h.adapter, {
        tenantId: 'tenant-a',
        transactionId: 'damt_1',
        campaignId: null,
        userId: 'u1',
        now: 10,
      })
    ).toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(1);
    const emitted = emittedLog();
    expect(emitted.overview.request_id).toBeNull();
    expect(emitted.row.campaign_id).toBeNull();
  });

  it('email code fallback returns false without side effects when no row was updated', async () => {
    for (const rowsAffected of [0, 2]) {
      const h = makeAdapter({ execute: () => ({ rowsAffected, success: true }) });
      expect(
        await completeDirectoryAuthEmailCodeFallback(env, h.adapter, {
          tenantId: 'tenant-a',
          transactionId: 'damt_1',
          campaignId: 'c1',
          userId: 'u1',
          now: 10,
        })
      ).toBe(false);
      expect(h.execute).toHaveBeenCalledTimes(1);
    }
    expect(vi.mocked(emitLogIcebergRow)).not.toHaveBeenCalled();
  });

  it('email code fallback uses the email_code_fallback scope by default', async () => {
    const h = makeAdapter();
    expect(
      await completeDirectoryAuthEmailCodeFallback(env, h.adapter, {
        tenantId: 'tenant-a',
        transactionId: 'damt_1',
        campaignId: 'c1',
        userId: 'u1',
        requestId: 'req-2',
        now: 10,
      })
    ).toBe(true);
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      10,
      10,
      'tenant-a',
      'damt_1',
      'email_code_fallback',
      10,
    ]);
    expect(h.execute.mock.calls[1][0]).toContain("state = 'recovered'");
    expect(h.execute.mock.calls[1][1]).toStrictEqual([10, 'tenant-a', 'c1', 'u1']);
    const emitted = emittedLog();
    expect(emitted.row.event_type).toBe('email_code_fallback.completed');
    expect(emitted.overview.action).toBe('email_code_fallback.completed');
    expect(emitted.row.request_id).toBe('req-2');
  });

  it('email code fallback recovery scope emits the recovery event and skips user update w/o campaign', async () => {
    const h = makeAdapter();
    expect(
      await completeDirectoryAuthEmailCodeFallback(env, h.adapter, {
        tenantId: 'tenant-a',
        transactionId: 'damt_1',
        campaignId: null,
        userId: 'u1',
        scope: 'recovery',
        now: 10,
      })
    ).toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0][1][4]).toBe('recovery');
    const emitted = emittedLog();
    expect(emitted.row.event_type).toBe('directory_unavailable_recovery.completed');
    expect(emitted.row.event_payload_json).toBe('{"completed_at":10}');
    expect(emitted.row.request_id).toBeNull();
  });

  it('marks a user enrolled with exact parameters', async () => {
    const h = makeAdapter();
    await markDirectoryAuthMigrationUserEnrolled(h.adapter, {
      tenantId: 'tenant-a',
      campaignId: 'c1',
      userId: 'u1',
      now: 50,
    });
    expect(h.execute.mock.calls[0][0]).toContain('COALESCE(enrolled_at, ?)');
    expect(h.execute.mock.calls[0][1]).toStrictEqual([50, 50, 'tenant-a', 'c1', 'u1']);
  });

  it('defaults times to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(9090);
      const h = makeAdapter();
      await markDirectoryAuthMigrationUserEnrolled(h.adapter, {
        tenantId: 't',
        campaignId: 'c',
        userId: 'u',
      });
      expect(h.execute.mock.calls[0][1].slice(0, 2)).toStrictEqual([9090, 9090]);
      await completeDirectoryAuthPasskeyEnrollment(env, h.adapter, {
        tenantId: 't',
        transactionId: 'x',
        campaignId: null,
        userId: 'u',
      });
      expect(h.execute.mock.calls[1][1]).toStrictEqual([9090, 9090, 't', 'x', 9090]);
      await completeDirectoryAuthEmailCodeFallback(env, h.adapter, {
        tenantId: 't',
        transactionId: 'x',
        campaignId: null,
        userId: 'u',
      });
      expect(h.execute.mock.calls[2][1]).toStrictEqual([
        9090,
        9090,
        't',
        'x',
        'email_code_fallback',
        9090,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('appendDirectoryAuthMigrationTransactionEvent', () => {
  it('emits a normal log row with null defaults and an empty payload', async () => {
    await appendDirectoryAuthMigrationTransactionEvent(env, {
      tenantId: 'tenant-a',
      transactionId: 'damt_1',
      eventType: 'custom',
      now: 5,
    });
    const emitEnv = vi.mocked(emitLogIcebergRow).mock.calls[0][0];
    const emitted = emittedLog();
    expect(emitEnv).toBe(env);
    expect(emitted).toMatchObject({
      tenantId: 'tenant-a',
      sourceDataset: 'core.directory_auth_migration_transaction_events',
      logType: 'normal',
      eventAt: 5,
      expiresAt: null,
      overview: { action: 'custom', request_id: null, subject_id: null, resource_id: 'damt_1' },
      row: {
        tenant_id: 'tenant-a',
        transaction_id: 'damt_1',
        campaign_id: null,
        user_id: null,
        event_type: 'custom',
        event_payload_json: '{}',
        request_id: null,
        created_at: 5,
      },
    });
  });

  it('uses Date.now() when no time is given and serializes the payload', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(31337);
      await appendDirectoryAuthMigrationTransactionEvent(env, {
        tenantId: 't',
        transactionId: 'x',
        eventType: 'e',
        eventPayload: { a: 1 },
        campaignId: 'c',
        userId: 'u',
        requestId: 'r',
      });
      const emitted = emittedLog();
      expect(emitted.eventAt).toBe(31337);
      expect(emitted.row).toMatchObject({
        created_at: 31337,
        event_payload_json: '{"a":1}',
        campaign_id: 'c',
        user_id: 'u',
        request_id: 'r',
      });
      expect(emitted.overview).toMatchObject({ request_id: 'r', subject_id: 'u' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cleanup and deletion', () => {
  it('expires transactions, evidence exports and support bundles with exact parameters', async () => {
    const h = makeAdapter({ execute: () => ({ rowsAffected: 4, success: true }) });
    expect(await cleanupExpiredDirectoryAuthMigrationTransactions(h.adapter, 'tenant-a', 100)).toBe(
      4
    );
    expect(h.execute.mock.calls[0][0]).toContain("token_hash = 'expired:' || id");
    expect(h.execute.mock.calls[0][0]).toContain('expires_at <= ?');
    expect(h.execute.mock.calls[0][1]).toStrictEqual([100, 'tenant-a', 100]);

    expect(await cleanupExpiredDirectoryAuthEvidenceExports(h.adapter, 'tenant-a', 100)).toBe(4);
    expect(h.execute.mock.calls[1][0]).toContain('directory_auth_evidence_exports');
    expect(h.execute.mock.calls[1][0]).toContain('retention_expires_at <= ?');
    expect(h.execute.mock.calls[1][1]).toStrictEqual([100, 100, 'tenant-a', 100]);

    expect(await cleanupExpiredDirectoryAuthSupportBundles(h.adapter, 'tenant-a', 100)).toBe(4);
    expect(h.execute.mock.calls[2][0]).toContain('directory_auth_support_bundles');
    expect(h.execute.mock.calls[2][1]).toStrictEqual([100, 100, 'tenant-a', 100]);
  });

  it('defaults cleanup time to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(600);
      const h = makeAdapter();
      await cleanupExpiredDirectoryAuthMigrationTransactions(h.adapter, 't');
      await cleanupExpiredDirectoryAuthEvidenceExports(h.adapter, 't');
      await cleanupExpiredDirectoryAuthSupportBundles(h.adapter, 't');
      expect(h.execute.mock.calls[0][1]).toStrictEqual([600, 't', 600]);
      expect(h.execute.mock.calls[1][1]).toStrictEqual([600, 600, 't', 600]);
      expect(h.execute.mock.calls[2][1]).toStrictEqual([600, 600, 't', 600]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates maintenance counts per resource', async () => {
    const h = makeAdapter({
      execute: (sql) => ({
        rowsAffected: sql.includes('migration_transactions')
          ? 1
          : sql.includes('evidence_exports')
            ? 2
            : 3,
        success: true,
      }),
    });
    expect(await cleanupExpiredDirectoryAuthMaintenance(h.adapter, 'tenant-a', 5)).toStrictEqual({
      migration_transactions_expired: 1,
      evidence_exports_expired: 2,
      evidence_exports_deleted: 0,
      support_bundles_expired: 3,
      support_bundles_deleted: 0,
    });
    expect(h.execute).toHaveBeenCalledTimes(3);
  });

  it('marks evidence exports and support bundles deleted only when a row changed', async () => {
    const changed = makeAdapter({ execute: () => ({ rowsAffected: 1, success: true }) });
    const unchanged = makeAdapter({ execute: () => ({ rowsAffected: 0, success: true }) });
    expect(await markDirectoryAuthEvidenceExportDeleted(changed.adapter, 't', 'e1', 9)).toBe(true);
    expect(changed.execute.mock.calls[0][0]).toContain("status IN ('expired', 'ready')");
    expect(changed.execute.mock.calls[0][1]).toStrictEqual([9, 9, 't', 'e1']);
    expect(await markDirectoryAuthEvidenceExportDeleted(unchanged.adapter, 't', 'e1', 9)).toBe(
      false
    );
    expect(await markDirectoryAuthSupportBundleDeleted(changed.adapter, 't', 'b1', 9)).toBe(true);
    expect(changed.execute.mock.calls[1][0]).toContain('directory_auth_support_bundles');
    expect(changed.execute.mock.calls[1][1]).toStrictEqual([9, 9, 't', 'b1']);
    expect(await markDirectoryAuthSupportBundleDeleted(unchanged.adapter, 't', 'b1', 9)).toBe(
      false
    );
    const many = makeAdapter({ execute: () => ({ rowsAffected: 2, success: true }) });
    expect(await markDirectoryAuthEvidenceExportDeleted(many.adapter, 't', 'e1', 9)).toBe(true);
    expect(await markDirectoryAuthSupportBundleDeleted(many.adapter, 't', 'b1', 9)).toBe(true);
  });

  it('defaults deletion time to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(321);
      const h = makeAdapter();
      await markDirectoryAuthEvidenceExportDeleted(h.adapter, 't', 'e');
      await markDirectoryAuthSupportBundleDeleted(h.adapter, 't', 'b');
      expect(h.execute.mock.calls[0][1]).toStrictEqual([321, 321, 't', 'e']);
      expect(h.execute.mock.calls[1][1]).toStrictEqual([321, 321, 't', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });
});
