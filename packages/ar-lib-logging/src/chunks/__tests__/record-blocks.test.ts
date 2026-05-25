import { describe, expect, it } from 'vitest';
import { decodeLogRecordFromBlock, encodeLogRecordBlocks } from '../record-blocks';

describe('record block encoding', () => {
  it('builds independently readable gzip blocks with per-record offsets', async () => {
    const records = [
      { id: 'evt-1', eventAt: 1, payload: { id: 'evt-1', message: 'first' } },
      { id: 'evt-2', eventAt: 2, payload: { id: 'evt-2', message: 'second' } },
      { id: 'evt-3', eventAt: 3, payload: { id: 'evt-3', message: 'third' } },
    ];

    const encoded = await encodeLogRecordBlocks(records, {
      compression: 'gzip_block',
      maxUncompressedBlockBytes: 48,
    });

    expect(encoded.blocks.length).toBeGreaterThan(1);
    expect(encoded.records).toHaveLength(records.length);

    for (const [index, location] of encoded.records.entries()) {
      const block = encoded.blocks[location.blockIndex];
      expect(block).toBeDefined();
      await expect(
        decodeLogRecordFromBlock(encoded.body, block!, location, encoded.compression)
      ).resolves.toEqual(records[index].payload);
      expect(location.recordId).toBe(records[index].id);
      expect(location.recordLength).toBeGreaterThan(0);
    }
  });

  it('keeps plain JSONL block offsets valid when compression is disabled', async () => {
    const records = [
      { id: 'evt-1', eventAt: 1, payload: { id: 'evt-1' } },
      { id: 'evt-2', eventAt: 2, payload: { id: 'evt-2' } },
    ];

    const encoded = await encodeLogRecordBlocks(records, { compression: 'none' });

    expect(encoded.blocks).toEqual([
      expect.objectContaining({
        blockIndex: 0,
        compressedOffset: 0,
        compressedLength: encoded.body.byteLength,
        recordCount: 2,
      }),
    ]);
    await expect(
      decodeLogRecordFromBlock(encoded.body, encoded.blocks[0]!, encoded.records[1]!, 'none')
    ).resolves.toEqual(records[1].payload);
  });
});
