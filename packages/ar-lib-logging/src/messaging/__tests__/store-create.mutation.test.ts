import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoggingMessageJobCreateInput } from '../types';
import { callAt, fullJobRecord, fullJobRow, storeHarness } from './store-mutation-harness';

afterEach(() => {
  vi.useRealTimers();
});

const minimal: LoggingMessageJobCreateInput = {
  id: 'job-min',
  kind: 'export_build',
  lane: 'default',
  topology: { topologyType: 'platform' },
  scopeType: 'platform',
  scopeKey: 'platform',
  sourceType: 'payload_object',
  sourceId: 'src-min',
  payloadObjectRef: 'ref-min',
  payloadSha256: 'sha-min',
  payloadType: 'ptype',
  payloadSchemaVersion: 1,
  now: 1000,
};

const full: LoggingMessageJobCreateInput = {
  id: 'job-1',
  kind: 'retry_delivery',
  lane: 'default',
  criticality: 'critical',
  priority: 3,
  topology: {
    tenantId: 'tenant-1',
    tenantKey: 'tkey-1',
    topologyType: 'external_db',
    databaseBindingRef: 'db-1',
    connectionRef: 'conn-1',
    topologySnapshotVersion: 'v1',
    topologyResolvedAt: 11,
  },
  scopeType: 'tenant',
  scopeId: 'scope-1',
  scopeKey: 'tenant:tkey-1',
  sourceType: 'dlq_item',
  sourceId: 'src-1',
  rootJobId: 'root-1',
  parentJobId: 'parent-1',
  depth: 2,
  payloadObjectRef: 'ref-1',
  payloadSha256: 'sha-1',
  payloadType: 'ptype',
  payloadSchemaVersion: 4,
  redactedSummary: { a: 1 },
  validationSummary: { b: 2 },
  idempotencyKey: 'idem-1',
  dedupeUntil: 12,
  notBefore: 13,
  maxAttempts: 6,
  attemptPolicy: { maxAttempts: 9, leaseTimeoutMs: 7 },
  requestedBy: 'admin-1',
  reason: 'because',
  errorClass: 'eclass',
  expiresAt: 21,
  now: 17,
};

describe('createJob', () => {
  it('writes every given field and returns the queued record', async () => {
    const { store, execute } = storeHarness();
    const record = await store.createJob(full);

    expect(execute).toHaveBeenCalledTimes(2);
    const reservation = callAt(execute, 0);
    expect(reservation.sql).toContain('INSERT INTO logging_message_idempotency_keys');
    expect(reservation.params).toEqual([
      'tenant:tkey-1',
      'idem-1',
      'job-1',
      'retry_delivery',
      'sha-1',
      'default',
      'critical',
      'active',
      12,
      17,
      17,
    ]);
    const insert = callAt(execute, 1);
    expect(insert.sql).toContain('INSERT INTO logging_message_jobs');
    expect(insert.params).toEqual([
      'job-1',
      'retry_delivery',
      'queued',
      'default',
      'critical',
      3,
      'tenant-1',
      'tkey-1',
      'external_db',
      'db-1',
      'conn-1',
      'v1',
      11,
      'tenant',
      'scope-1',
      'tenant:tkey-1',
      'dlq_item',
      'src-1',
      'root-1',
      'parent-1',
      2,
      'ref-1',
      'sha-1',
      'ptype',
      4,
      '{"a":1}',
      '{"b":2}',
      'idem-1',
      12,
      13,
      0,
      6,
      '{"maxAttempts":9,"leaseTimeoutMs":7}',
      null,
      null,
      null,
      'admin-1',
      'because',
      'eclass',
      null,
      null,
      null,
      null,
      17,
      17,
      null,
      null,
      21,
    ]);
    expect(record).toStrictEqual({
      ...fullJobRecord,
      maxAttempts: 6,
      attemptPolicy: { maxAttempts: 9, leaseTimeoutMs: 7 },
      attemptCount: 0,
      claimToken: null,
      claimedAt: null,
      claimedUntil: null,
      lastError: null,
      blockedReason: null,
      cancelRequestedAt: null,
      cancelledBy: null,
      createdAt: 17,
      updatedAt: 17,
      startedAt: null,
      completedAt: null,
    });
  });

  it('fills every default of a minimal job and skips idempotency without a key', async () => {
    const { store, execute, queryOne } = storeHarness();
    const record = await store.createJob(minimal);

    expect(queryOne).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(callAt(execute).params).toEqual([
      'job-min',
      'export_build',
      'queued',
      'default',
      'standard',
      0,
      null,
      null,
      'platform',
      null,
      null,
      null,
      null,
      'platform',
      null,
      'platform',
      'payload_object',
      'src-min',
      null,
      null,
      0,
      'ref-min',
      'sha-min',
      'ptype',
      1,
      null,
      null,
      null,
      null,
      1000,
      0,
      5,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1000,
      1000,
      null,
      null,
      null,
    ]);
    expect(record).toStrictEqual({
      id: 'job-min',
      kind: 'export_build',
      status: 'queued',
      lane: 'default',
      criticality: 'standard',
      priority: 0,
      tenantId: null,
      tenantKey: null,
      topologyType: 'platform',
      databaseBindingRef: null,
      connectionRef: null,
      topologySnapshotVersion: null,
      topologyResolvedAt: null,
      scopeType: 'platform',
      scopeId: null,
      scopeKey: 'platform',
      sourceType: 'payload_object',
      sourceId: 'src-min',
      rootJobId: null,
      parentJobId: null,
      depth: 0,
      payloadObjectRef: 'ref-min',
      payloadSha256: 'sha-min',
      payloadType: 'ptype',
      payloadSchemaVersion: 1,
      redactedSummary: null,
      validationSummary: null,
      idempotencyKey: null,
      dedupeUntil: null,
      notBefore: 1000,
      attemptCount: 0,
      maxAttempts: 5,
      attemptPolicy: null,
      claimToken: null,
      claimedAt: null,
      claimedUntil: null,
      requestedBy: null,
      reason: null,
      errorClass: null,
      lastError: null,
      blockedReason: null,
      cancelRequestedAt: null,
      cancelledBy: null,
      createdAt: 1000,
      updatedAt: 1000,
      startedAt: null,
      completedAt: null,
      expiresAt: null,
    });
  });

  it('stores empty summaries and policies as null', async () => {
    const { store, execute } = storeHarness();
    await store.createJob({
      ...minimal,
      redactedSummary: {},
      validationSummary: {},
    });
    const params = callAt(execute).params;
    expect(params[25]).toBeNull();
    expect(params[26]).toBeNull();
  });

  it('names a job made at the given time, or now', async () => {
    const { store } = storeHarness();
    const withoutId = { ...minimal, id: undefined };
    expect((await store.createJob({ ...withoutId, now: 0x0123456789ab })).id).toMatch(
      /^lmj_01234567-89ab-7/
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0x0123456789ab));
    const record = await store.createJob({ ...withoutId, now: undefined });
    expect(record.id).toMatch(/^lmj_01234567-89ab-7/);
    expect(record.createdAt).toBe(0x0123456789ab);
    expect(record.notBefore).toBe(0x0123456789ab);
  });

  it('allows the maximum depth and refuses one more', async () => {
    const { store, execute } = storeHarness({ maxDepth: 3 });
    await expect(store.createJob({ ...minimal, depth: 3 })).resolves.toMatchObject({ depth: 3 });
    await expect(store.createJob({ ...minimal, depth: 4 })).rejects.toThrow(
      'logging_message_job_depth_exceeded'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const defaults = storeHarness();
    await expect(defaults.store.createJob({ ...minimal, depth: 16 })).resolves.toBeDefined();
    await expect(defaults.store.createJob({ ...minimal, depth: 17 })).rejects.toThrow(
      'logging_message_job_depth_exceeded'
    );
  });

  it('takes the attempt limit from the job, then its policy, then the default', async () => {
    const { store } = storeHarness();
    const policy = { maxAttempts: 9, leaseTimeoutMs: 1 };
    expect(
      (await store.createJob({ ...minimal, maxAttempts: 2, attemptPolicy: policy })).maxAttempts
    ).toBe(2);
    expect((await store.createJob({ ...minimal, attemptPolicy: policy })).maxAttempts).toBe(9);
    expect((await store.createJob(minimal)).maxAttempts).toBe(5);
  });

  it('takes the root job from the job, then its parent', async () => {
    const { store } = storeHarness();
    expect(
      (await store.createJob({ ...minimal, rootJobId: 'r', parentJobId: 'p' })).rootJobId
    ).toBe('r');
    expect((await store.createJob({ ...minimal, parentJobId: 'p' })).rootJobId).toBe('p');
    expect((await store.createJob(minimal)).rootJobId).toBeNull();
  });
});

describe('createJob idempotency', () => {
  const keyed = { ...minimal, scopeKey: 'scope-k', idempotencyKey: 'key-1' };

  it('keeps a reservation for a day when the job gives no dedupe time', async () => {
    const { store, execute } = storeHarness();
    await store.createJob(keyed);
    expect(callAt(execute, 0).params).toEqual([
      'scope-k',
      'key-1',
      'job-min',
      'export_build',
      'sha-min',
      'default',
      'standard',
      'active',
      1000 + 86_400_000,
      1000,
      1000,
    ]);
    await store.createJob({ ...keyed, expiresAt: 5000 });
    expect(callAt(execute, 2).params[8]).toBe(5000);
    await store.createJob({ ...keyed, expiresAt: 5000, dedupeUntil: 7000 });
    expect(callAt(execute, 4).params[8]).toBe(7000);
  });

  it('returns the job that holds a live reservation without writing another', async () => {
    const { store, execute, queryOne } = storeHarness();
    queryOne
      .mockResolvedValueOnce({ message_job_id: 'old-job', dedupe_until: 1001, status: 'active' })
      .mockResolvedValueOnce(fullJobRow({ id: 'old-job' }));

    const record = await store.createJob(keyed);

    expect(record).toMatchObject({ id: 'old-job' });
    expect(execute).not.toHaveBeenCalled();
    const lookup = callAt(queryOne, 0);
    expect(lookup.sql).toContain('FROM logging_message_idempotency_keys');
    expect(lookup.sql).toContain('WHERE scope_key = ? AND idempotency_key = ?');
    expect(lookup.params).toEqual(['scope-k', 'key-1']);
    expect(callAt(queryOne, 1).params).toEqual(['old-job']);
  });

  it('writes the job anyway when the job of a live reservation is gone', async () => {
    const { store, execute, queryOne } = storeHarness();
    queryOne
      .mockResolvedValueOnce({ message_job_id: 'old-job', dedupe_until: 2000, status: 'active' })
      .mockResolvedValueOnce(null);
    expect((await store.createJob(keyed)).id).toBe('job-min');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(callAt(execute).sql).toContain('INSERT INTO logging_message_jobs');
  });

  it('takes over a reservation that has lapsed or is not active', async () => {
    for (const existing of [
      { message_job_id: 'old', dedupe_until: 1000, status: 'active' },
      { message_job_id: 'old', dedupe_until: 999, status: 'active' },
      { message_job_id: 'old', dedupe_until: 9999, status: 'released' },
    ]) {
      const { store, execute, queryOne } = storeHarness();
      queryOne.mockResolvedValueOnce(existing);
      expect((await store.createJob(keyed)).id).toBe('job-min');
      expect(execute).toHaveBeenCalledTimes(2);
      expect(callAt(execute, 0).sql).toContain('UPDATE logging_message_idempotency_keys');
      expect(callAt(execute, 1).sql).toContain('INSERT INTO logging_message_jobs');
    }
  });
});

describe('job rows', () => {
  it('reads a job by id and maps every column', async () => {
    const { store, queryOne } = storeHarness();
    queryOne.mockResolvedValueOnce(fullJobRow());
    expect(await store.getJob('job-1')).toStrictEqual(fullJobRecord);
    expect(callAt(queryOne)).toEqual({
      sql: 'SELECT * FROM logging_message_jobs WHERE id = ?',
      params: ['job-1'],
    });
    expect(await store.getJob('missing')).toBeNull();
  });

  it('reads absent or non-object JSON columns as null', async () => {
    const { store, queryOne } = storeHarness();
    for (const json of [null, '', '[1]', '"text"', '5', 'null']) {
      queryOne.mockResolvedValueOnce(
        fullJobRow({
          redacted_summary_json: json,
          validation_summary_json: json,
          attempt_policy_json: json,
        })
      );
      expect(await store.getJob('job-1')).toMatchObject({
        redactedSummary: null,
        validationSummary: null,
        attemptPolicy: null,
      });
    }
  });
});
