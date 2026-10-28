import { describe, expect, it } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { writeParquet } from 'icebird/src/write/parquet.js';
import { advanceIcebergMainForGc } from '../gc-fence.js';
import { assertLogArchiveRewriteBudget } from '../rewrite-budget.js';
import { IcebergBudgetError, IcebergCommitUnknownError } from '../types.js';
import { MemoryCatalog, MemoryStore, record } from './fixtures.js';

describe('GC write fence and semantic rewrite budget', () => {
  it('creates an empty main barrier and reconciles a lost acknowledgement without a second snapshot', async () => {
    const catalog = new MemoryCatalog();
    const store = new MemoryStore();
    let once = true;
    catalog.afterCommit = async () => {
      if (once) {
        once = false;
        throw new IcebergCommitUnknownError('lost');
      }
    };
    const options = {
      catalog,
      store,
      operationId: 'f'.repeat(64),
      assertFence: async () => undefined,
    };
    const first = await advanceIcebergMainForGc(options);
    expect(first.sequenceNumber).toBe(1);
    expect(catalog.metadata.snapshots).toHaveLength(1);
    expect((await advanceIcebergMainForGc(options)).snapshotId).toBe(first.snapshotId);
    expect(catalog.metadata.snapshots).toHaveLength(1);
  });
  it('bounds logically expanded ciphertext before the native rewrite writer allocates from repeated dictionary values', async () => {
    const catalog = new MemoryCatalog();
    const store = new MemoryStore();
    const output = new ByteWriter();
    const records = Array.from({ length: 12 }, (_, index) => ({
      ...record({ event_id: `event-${index}`, detail_ciphertext: 'x'.repeat(500_000) }),
      event_at: 1793000000000n,
      ingested_at: 1793000001000n,
      expires_at: null,
    }));
    await writeParquet({
      writer: output,
      schema: catalog.metadata.schemas[0],
      records,
      codec: 'SNAPPY',
    });
    expect(output.getBytes().length).toBeLessThan(8 * 1024 * 1024);
    await store.putImmutable('small.parquet', output.getBytes(), 'fixture');
    await expect(
      assertLogArchiveRewriteBudget({
        table: await catalog.loadTable(),
        store,
        path: 'small.parquet',
      })
    ).rejects.toBeInstanceOf(IcebergBudgetError);
  });
});
