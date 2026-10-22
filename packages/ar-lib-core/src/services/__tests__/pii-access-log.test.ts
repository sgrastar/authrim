import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { disclosedPiiFields, PiiAccessLog, schedulePiiAccessLog } from '../pii-access-log';

function recordingStore() {
  const batches: PreparedStatement[][] = [];
  const adapter = {
    batch: vi.fn(async (statements: PreparedStatement[]) => {
      batches.push(statements);
      return statements.map(() => ({ success: true, rowsAffected: 1 }));
    }),
  } as unknown as DatabaseAdapter;
  return { adapter, batches };
}

const context = {
  tenantId: 'tenant-a',
  actorId: 'admin-1',
  actorType: 'human',
  requestId: 'req-1',
  operation: 'admin.users.list',
};

describe('disclosedPiiFields', () => {
  it('names only the fields returned with a value', () => {
    expect(
      disclosedPiiFields({ email: 'a@example.com', name: '', phone_number: null, id: 'u' }, [
        'email',
        'name',
        'phone_number',
        'birthdate',
      ])
    ).toEqual(['email']);
  });
});

describe('PiiAccessLog', () => {
  it('writes one record per user read, in the store the data came from, without values', async () => {
    const first = recordingStore();
    const second = recordingStore();
    const accessLog = new PiiAccessLog(context);
    accessLog.add({ key: 'PII_A', adapter: first.adapter }, 'user-1', ['email', 'name']);
    accessLog.add({ key: 'PII_B', adapter: second.adapter }, 'user-2', ['email']);
    accessLog.add({ key: 'PII_A', adapter: first.adapter }, 'user-3', []);

    await expect(accessLog.write()).resolves.toEqual({ written: 2, failedStores: 0 });

    expect(first.batches).toHaveLength(1);
    expect(first.batches[0]).toHaveLength(1);
    const [statement] = first.batches[0];
    expect(statement.sql).toContain('INSERT INTO audit_log_pii');
    const params = statement.params as unknown[];
    expect(params.slice(1, 5)).toEqual(['tenant-a', 'admin-1', 'pii_accessed', 'user-1']);
    expect(JSON.parse(params[5] as string)).toEqual({
      fields: ['email', 'name'],
      operation: 'admin.users.list',
      request_id: 'req-1',
      actor_type: 'human',
    });
    expect(JSON.stringify(params)).not.toContain('@');
    expect(second.batches[0][0].params?.[4]).toBe('user-2');
  });

  it('splits a large page into bounded batches', async () => {
    const store = recordingStore();
    const accessLog = new PiiAccessLog(context);
    for (let index = 0; index < 120; index++) {
      accessLog.add({ key: 'PII_A', adapter: store.adapter }, `user-${index}`, ['email']);
    }
    await accessLog.write();
    expect(store.batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
  });

  it('keeps writing the other stores when one fails', async () => {
    const failing = {
      batch: vi.fn(async () => {
        throw new Error('d1_unavailable');
      }),
    } as unknown as DatabaseAdapter;
    const working = recordingStore();
    const accessLog = new PiiAccessLog(context);
    accessLog.add({ key: 'PII_A', adapter: failing }, 'user-1', ['email']);
    accessLog.add({ key: 'PII_B', adapter: working.adapter }, 'user-2', ['email']);
    await expect(accessLog.write()).resolves.toEqual({ written: 1, failedStores: 1 });
    expect(working.batches).toHaveLength(1);
  });
});

describe('schedulePiiAccessLog', () => {
  it('hands the write to waitUntil and never rejects', async () => {
    const store = {
      batch: vi.fn(async () => {
        throw new Error('d1_unavailable');
      }),
    } as unknown as DatabaseAdapter;
    const accessLog = new PiiAccessLog(context);
    accessLog.add({ key: 'PII_A', adapter: store }, 'user-1', ['email']);
    const waitUntil = vi.fn();
    await expect(schedulePiiAccessLog({}, { waitUntil }, accessLog, 'tenant-a')).resolves.toBe(
      undefined
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when nothing was read', async () => {
    const waitUntil = vi.fn();
    await schedulePiiAccessLog({}, { waitUntil }, new PiiAccessLog(context), 'tenant-a');
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
