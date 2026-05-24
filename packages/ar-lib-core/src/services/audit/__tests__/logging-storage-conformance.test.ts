import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit-service';
import type { AuditProfile } from '../../../types/runtime-profile';

const OBJECT_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface PreparedStatementCall {
  sql: string;
  params: unknown[];
}

function createRecordingD1(firstResults: unknown[] = [null]): D1Database & {
  calls: PreparedStatementCall[];
} {
  const calls: PreparedStatementCall[] = [];
  const firstQueue = [...firstResults];

  const db = {
    calls,
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn((...params: unknown[]) => {
          calls.push({ sql, params });
          return statement;
        }),
        first: vi.fn(async () => (firstQueue.length > 0 ? (firstQueue.shift() ?? null) : null)),
        run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ''),
    dump: vi.fn(async () => new ArrayBuffer(0)),
  };

  return db as unknown as D1Database & { calls: PreparedStatementCall[] };
}

function createRecordingBucket(): R2Bucket & {
  writes: Array<{ key: string; body: Uint8Array | string }>;
} {
  const writes: Array<{ key: string; body: Uint8Array | string }> = [];
  const bucket = {
    writes,
    put: vi.fn(async (key: string, body: Uint8Array | string) => {
      writes.push({ key, body });
      return null;
    }),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    head: vi.fn(async () => null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  };

  return bucket as unknown as R2Bucket & {
    writes: Array<{ key: string; body: Uint8Array | string }>;
  };
}

function auditProfile(dataset: 'event_log' | 'pii_log'): AuditProfile {
  return {
    id: `conformance-${dataset}`,
    kind: 'audit',
    label: `Conformance ${dataset}`,
    primary: { type: 'd1', bindingRef: dataset === 'event_log' ? 'DB' : 'DB_PII', dataset },
    archive: null,
    sinks: [],
    archiveFailureMode: 'best_effort',
    sinkFailureMode: 'best_effort',
  };
}

function findInsert(calls: PreparedStatementCall[], table: string): PreparedStatementCall {
  const call = calls.find((item) => item.sql.includes(`INSERT INTO ${table}`));
  if (!call) {
    throw new Error(`missing insert for ${table}`);
  }
  return call;
}

describe('logging/storage conformance', () => {
  let coreDb: D1Database & { calls: PreparedStatementCall[] };
  let piiDb: D1Database & { calls: PreparedStatementCall[] };
  let bucket: R2Bucket & { writes: Array<{ key: string; body: Uint8Array | string }> };

  beforeEach(() => {
    coreDb = createRecordingD1();
    piiDb = createRecordingD1();
    bucket = createRecordingBucket();
  });

  it('stores oversized unified audit details as tenant-keyed sensitive chunks', async () => {
    const service = new AuditService({
      coreSource: coreDb,
      piiSource: piiDb,
      r2Bucket: bucket,
      sensitiveDetailBucket: bucket,
      objectEncryptionRootKey: OBJECT_ROOT_KEY,
      objectEncryptionKeyVersion: 7,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile('event_log')),
      tenantKeyResolver: vi.fn(async (tenantId: string) =>
        tenantId === 'tenant-a' ? 't_conf_a' : 't_conf_b'
      ),
    });

    await service.logEvent('tenant-a', {
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
      details: { payload: 'a'.repeat(3000) },
    });
    await service.logEvent('tenant-b', {
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
      details: { payload: 'b'.repeat(3000) },
    });

    expect(bucket.writes).toHaveLength(2);
    expect(bucket.writes[0].key).toContain('/t_conf_a/sensitive_detail/event/audit/');
    expect(bucket.writes[1].key).toContain('/t_conf_b/sensitive_detail/event/audit/');
    expect(bucket.writes.map((write) => write.key).join('\n')).not.toContain('tenant-a');
    expect(bucket.writes.map((write) => write.key).join('\n')).not.toContain('tenant-b');

    const eventInserts = coreDb.calls.filter((call) => call.sql.includes('INSERT INTO event_log'));
    expect(eventInserts).toHaveLength(2);
    expect(eventInserts[0].params[13]).toMatch(/^sensitive-detail-catalog:/);
    expect(eventInserts[0].params[14]).toBeNull();
    expect(eventInserts[1].params[13]).toMatch(/^sensitive-detail-catalog:/);
    expect(eventInserts[1].params[14]).toBeNull();
    expect(
      coreDb.calls.some((call) => call.sql.includes('INSERT INTO sensitive_detail_chunk_index'))
    ).toBe(true);
  });

  it('routes oversized PII values through sensitive chunks while keeping PII rows in PII DB', async () => {
    const service = new AuditService({
      coreSource: coreDb,
      piiSource: piiDb,
      r2Bucket: bucket,
      sensitiveDetailBucket: bucket,
      objectEncryptionRootKey: OBJECT_ROOT_KEY,
      objectEncryptionKeyVersion: 7,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile('pii_log')),
      tenantKeyResolver: vi.fn(async () => 't_conf_pii'),
    });

    await service.logPIIChange('tenant-pii', {
      userId: 'user-1',
      anonymizedUserId: 'anon-1',
      changeType: 'update',
      affectedFields: ['profile'],
      newValues: { profile: 'x'.repeat(6000) },
      actorType: 'admin',
    });

    expect(bucket.writes).toHaveLength(1);
    expect(bucket.writes[0].key).toContain('/t_conf_pii/sensitive_detail/pii/pii/');
    expect(bucket.writes[0].key).not.toContain('tenant-pii');

    const piiInsert = findInsert(piiDb.calls, 'pii_log');
    expect(piiInsert.params[6]).toMatch(/^sensitive-detail-catalog:/);
    expect(piiInsert.params[7]).toBeNull();
    expect(coreDb.calls.some((call) => call.sql.includes('INSERT INTO pii_log'))).toBe(false);
    expect(
      coreDb.calls.some((call) => call.sql.includes('INSERT INTO sensitive_detail_chunk_index'))
    ).toBe(true);
  });

  it('fails closed instead of falling back to legacy per-record R2 objects', async () => {
    const service = new AuditService({
      coreSource: coreDb,
      piiSource: piiDb,
      r2Bucket: bucket,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile('event_log')),
      tenantKeyResolver: vi.fn(async () => 't_conf_missing'),
    });

    await expect(
      service.logEvent('tenant-a', {
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'success',
        details: { payload: 'x'.repeat(3000) },
      })
    ).rejects.toThrow('sensitive_detail_chunk_context_required:event_log_detail');

    expect(bucket.writes).toHaveLength(0);
    expect(coreDb.calls.some((call) => call.sql.includes('INSERT INTO event_log'))).toBe(false);
  });
});
