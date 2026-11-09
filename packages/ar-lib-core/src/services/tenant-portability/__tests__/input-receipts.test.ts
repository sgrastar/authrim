import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantBackupInputReceipts } from '../input-receipts';

const mocks = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock('../input-decode-step', () => ({ decodeTenantBackupInputStep: mocks.decode }));

const bundleId = 'ab'.repeat(16);
const lease = {
  tenantId: 'tenant-a',
  operationId: 'operation-a',
  owner: 'worker-a',
  fencingToken: 7,
};
const checkpoint = {
  version: 1,
  identity: { key: 'backup/object', version: 'v1', etag: 'etag', size: 100 },
  transport: { offset: 100, frames: 1 },
  headerHex: 'ab'.repeat(125),
  cipher: { chunks: 0, bytes: 0, complete: false },
  content: { phase: 'header' },
  complete: false,
};
const headerResult = { event: { kind: 'header' }, checkpoint };
const input = {
  manifest: { datasets: [{ id: 'core.users' }, { id: 'core.clients' }] },
  expected: { bundleId },
};

function harness(now: () => number = () => 100) {
  const queryOne = vi.fn();
  const receipts = new TenantBackupInputReceipts({ queryOne } as never, lease, now);
  return { receipts, queryOne };
}

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => mocks.decode.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('TenantBackupInputReceipts.latest', () => {
  it('reads the latest receipt only while the exact import lease is live', async () => {
    const { receipts, queryOne } = harness();
    queryOne
      .mockResolvedValueOnce({ id: lease.operationId })
      .mockResolvedValueOnce({ sequence: 5, checkpoint_json: JSON.stringify(checkpoint) });

    expect(await receipts.latest(bundleId)).toEqual({ sequence: 5, checkpoint });
    expect(queryOne).toHaveBeenCalledTimes(2);
    expect(queryOne.mock.calls[0][0]).toContain("kind='import' AND state='running'");
    expect(queryOne.mock.calls[0][1]).toEqual(['operation-a', 'tenant-a', 'worker-a', 7, 100, 100]);
    expect(queryOne.mock.calls[1][1]).toEqual([
      'operation-a',
      'tenant-a',
      bundleId,
      'worker-a',
      7,
      100,
      100,
    ]);
  });

  it('fails closed on a lost lease before reading any receipt', async () => {
    const { receipts, queryOne } = harness();
    queryOne.mockResolvedValue(null);

    await expect(receipts.latest(bundleId)).rejects.toThrow('backup_input_receipt_failed');
    expect(queryOne).toHaveBeenCalledOnce();
  });

  it.each(['not-hex', 'AB'.repeat(16), 'ab'.repeat(15)])(
    'rejects an invalid bundle identity before database access: %s',
    async (invalidId) => {
      const { receipts, queryOne } = harness();
      await expect(receipts.latest(invalidId)).rejects.toThrow('backup_input_receipt_failed');
      expect(queryOne).not.toHaveBeenCalled();
    }
  );

  it('rejects a non-integer clock before database access', async () => {
    const { receipts, queryOne } = harness(() => 1.5);
    await expect(receipts.latest(bundleId)).rejects.toThrow('backup_input_receipt_failed');
    expect(queryOne).not.toHaveBeenCalled();
  });
});

describe('TenantBackupInputReceipts.append', () => {
  it('commits one pinned checkpoint and event hash behind the lease and predecessor fences', async () => {
    const { receipts, queryOne } = harness();
    let savedCheckpoint = '';
    let savedHash = '';
    queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT')) {
        savedCheckpoint = params[2] as string;
        savedHash = params[3] as string;
        return { sequence: 0 };
      }
      return { sequence: 0, checkpoint_json: savedCheckpoint, event_sha256: savedHash };
    });
    const mutable = structuredClone(headerResult);
    const write = receipts.append(bundleId, 0, null, mutable as never);
    mutable.checkpoint.identity.key = 'mutated-after-call';
    await write;

    expect(JSON.parse(savedCheckpoint)).toEqual(checkpoint);
    expect(savedHash).toBe(await hash({ kind: 'header' }));
    expect(queryOne).toHaveBeenCalledTimes(2);
    expect(queryOne.mock.calls[0][0]).toContain('lease_owner=? AND o.fencing_token=?');
    expect(queryOne.mock.calls[0][0]).toContain('p.checkpoint_json=?');
    expect(queryOne.mock.calls[0][0]).toContain('p.sequence>=?');
    expect(queryOne.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['operation-a', 'tenant-a', 'worker-a', 7, 100])
    );
  });

  it.each([
    { sequence: -1, previous: null, result: headerResult },
    { sequence: 1.5, previous: null, result: headerResult },
    { sequence: 1, previous: null, result: headerResult },
    { sequence: 0, previous: checkpoint, result: headerResult },
    {
      sequence: 0,
      previous: null,
      result: { ...headerResult, checkpoint: { ...checkpoint, transport: { frames: 2 } } },
    },
    { sequence: 0, previous: null, result: { ...headerResult, event: { kind: 'footer' } } },
  ])('rejects an inconsistent event sequence before any write: %#', async (sample) => {
    const { receipts, queryOne } = harness();

    await expect(
      receipts.append(bundleId, sample.sequence, sample.previous as never, sample.result as never)
    ).rejects.toThrow('backup_input_receipt_failed');
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('rejects an uncertain write when the stored receipt differs from the event', async () => {
    const { receipts, queryOne } = harness();
    queryOne.mockResolvedValueOnce({ sequence: 0 }).mockResolvedValueOnce({
      sequence: 0,
      checkpoint_json: JSON.stringify(checkpoint),
      event_sha256: '0'.repeat(64),
    });

    await expect(receipts.append(bundleId, 0, null, headerResult as never)).rejects.toThrow(
      'backup_input_receipt_failed'
    );
    expect(queryOne).toHaveBeenCalledTimes(2);
  });
});

describe('TenantBackupInputReceipts.replay', () => {
  it('authenticates the checkpoint and event hash and rereads the receipt before returning', async () => {
    const { receipts, queryOne } = harness();
    vi.spyOn(receipts, 'latest').mockResolvedValue({
      sequence: 0,
      checkpoint: { ...checkpoint, complete: true } as never,
    });
    const stored = {
      sequence: 0,
      checkpoint_json: JSON.stringify(checkpoint),
      event_sha256: await hash({ kind: 'header' }),
    };
    queryOne.mockResolvedValue(stored);
    mocks.decode.mockResolvedValue(headerResult);

    await expect(receipts.replay(bundleId, 0, input as never)).resolves.toEqual({ kind: 'header' });
    expect(mocks.decode).toHaveBeenCalledExactlyOnceWith({ ...input, checkpoint: null });
    expect(queryOne).toHaveBeenCalledTimes(2);
    expect(queryOne.mock.calls[0][1]).toEqual(queryOne.mock.calls[1][1]);
  });

  it('rejects tampered event evidence before returning the decoded event', async () => {
    const { receipts, queryOne } = harness();
    vi.spyOn(receipts, 'latest').mockResolvedValue({
      sequence: 0,
      checkpoint: { ...checkpoint, complete: true } as never,
    });
    queryOne.mockResolvedValue({
      sequence: 0,
      checkpoint_json: JSON.stringify(checkpoint),
      event_sha256: '0'.repeat(64),
    });
    mocks.decode.mockResolvedValue(headerResult);

    await expect(receipts.replay(bundleId, 0, input as never)).rejects.toThrow(
      'backup_input_receipt_failed'
    );
    expect(queryOne).toHaveBeenCalledOnce();
  });

  it('rejects an out-of-range sequence or incomplete input before decoding', async () => {
    const { receipts, queryOne } = harness();
    const latest = vi.spyOn(receipts, 'latest').mockResolvedValue(null);

    await expect(receipts.replay(bundleId, -1, input as never)).rejects.toThrow(
      'backup_input_receipt_failed'
    );
    expect(latest).not.toHaveBeenCalled();
    await expect(receipts.replay(bundleId, 0, input as never)).rejects.toThrow(
      'backup_input_receipt_failed'
    );
    expect(queryOne).not.toHaveBeenCalled();
    expect(mocks.decode).not.toHaveBeenCalled();
  });
});

describe('TenantBackupInputReceipts.datasetStart', () => {
  it('requires a completed input and the authenticated preceding dataset boundary', async () => {
    const { receipts, queryOne } = harness();
    vi.spyOn(receipts, 'latest').mockResolvedValue({
      sequence: 8,
      checkpoint: { ...checkpoint, complete: true } as never,
    });
    const replay = vi.spyOn(receipts, 'replay').mockResolvedValue({
      kind: 'dataset_end',
      datasetId: 'core.users',
    } as never);
    queryOne.mockResolvedValue({ sequence: 4 });

    await expect(receipts.datasetStart(bundleId, 'core.clients', input as never)).resolves.toBe(5);
    expect(queryOne.mock.calls[0][0]).toContain(
      "json_extract(checkpoint_json,'$.content.datasetIndex')=?"
    );
    const params = queryOne.mock.calls[0][1] as unknown[];
    expect(params[params.length - 1]).toBe(1);
    expect(replay).toHaveBeenCalledWith(bundleId, 4, input);
  });

  it('does not trust a boundary associated with another dataset', async () => {
    const { receipts, queryOne } = harness();
    vi.spyOn(receipts, 'latest').mockResolvedValue({
      sequence: 8,
      checkpoint: { ...checkpoint, complete: true } as never,
    });
    vi.spyOn(receipts, 'replay').mockResolvedValue({
      kind: 'dataset_end',
      datasetId: 'core.clients',
    } as never);
    queryOne.mockResolvedValue({ sequence: 4 });

    await expect(receipts.datasetStart(bundleId, 'core.clients', input as never)).rejects.toThrow(
      'backup_input_receipt_failed'
    );
  });

  it('rejects unknown datasets and mismatched bundle IDs without database access', async () => {
    const { receipts, queryOne } = harness();
    await expect(receipts.datasetStart(bundleId, 'unknown', input as never)).rejects.toThrow(
      'backup_input_receipt_failed'
    );
    await expect(
      receipts.datasetStart(bundleId, 'core.users', {
        ...input,
        expected: { bundleId: 'cd'.repeat(16) },
      } as never)
    ).rejects.toThrow('backup_input_receipt_failed');
    expect(queryOne).not.toHaveBeenCalled();
  });
});
