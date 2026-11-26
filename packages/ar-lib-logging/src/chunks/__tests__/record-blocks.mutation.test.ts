import { describe, expect, it } from 'vitest';
import { decodeLogRecordFromBlock, encodeLogRecordBlocks } from '../record-blocks';

const record = (id: string, payload: unknown = { id }) => ({ id, eventAt: 1, payload });
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('encodeLogRecordBlocks', () => {
  it('lays plain records out one JSON line each, with no newline after the last', async () => {
    const encoded = await encodeLogRecordBlocks([record('a'), record('b'), record('c')], {
      compression: 'none',
    });
    expect(text(encoded.body)).toBe('{"id":"a"}\n{"id":"b"}\n{"id":"c"}');
    expect(encoded.compression).toBe('none');
    expect(encoded.blocks).toStrictEqual([
      {
        blockIndex: 0,
        compressedOffset: 0,
        compressedLength: 32,
        uncompressedLength: 32,
        firstLineNumber: 0,
        lastLineNumber: 2,
        recordCount: 3,
      },
    ]);
    expect(encoded.records).toStrictEqual([
      { recordId: 'a', lineNumber: 0, blockIndex: 0, recordOffset: 0, recordLength: 10 },
      { recordId: 'b', lineNumber: 1, blockIndex: 0, recordOffset: 11, recordLength: 10 },
      { recordId: 'c', lineNumber: 2, blockIndex: 0, recordOffset: 22, recordLength: 10 },
    ]);
  });

  it('writes nothing for no records', async () => {
    for (const compression of ['none', 'gzip_block'] as const) {
      const encoded = await encodeLogRecordBlocks([], { compression });
      expect(encoded.body).toHaveLength(0);
      expect(encoded.blocks).toEqual([]);
      expect(encoded.records).toEqual([]);
      expect(encoded.compression).toBe(compression);
    }
  });

  it('starts a new block when the next line would pass the limit, not when it reaches it', async () => {
    // Each stored line is 11 bytes except the last, which has no newline (10 bytes).
    const records = [record('a'), record('b'), record('c'), record('d')];
    const at = async (maxUncompressedBlockBytes: number) =>
      (
        await encodeLogRecordBlocks(records, { compression: 'none', maxUncompressedBlockBytes })
      ).blocks.map((block) => block.recordCount);
    expect(await at(22)).toEqual([2, 2]);
    expect(await at(21)).toEqual([1, 1, 2]);
    expect(await at(32)).toEqual([2, 2]);
    expect(await at(33)).toEqual([3, 1]);
    expect(await at(43)).toEqual([4]);
    expect(await at(1)).toEqual([1, 1, 1, 1]);
  });

  it('numbers blocks and lines across blocks and records where each block starts', async () => {
    const encoded = await encodeLogRecordBlocks([record('a'), record('b'), record('c')], {
      compression: 'none',
      maxUncompressedBlockBytes: 11,
    });
    expect(encoded.blocks).toStrictEqual([
      {
        blockIndex: 0,
        compressedOffset: 0,
        compressedLength: 11,
        uncompressedLength: 11,
        firstLineNumber: 0,
        lastLineNumber: 0,
        recordCount: 1,
      },
      {
        blockIndex: 1,
        compressedOffset: 11,
        compressedLength: 11,
        uncompressedLength: 11,
        firstLineNumber: 1,
        lastLineNumber: 1,
        recordCount: 1,
      },
      {
        blockIndex: 2,
        compressedOffset: 22,
        compressedLength: 10,
        uncompressedLength: 10,
        firstLineNumber: 2,
        lastLineNumber: 2,
        recordCount: 1,
      },
    ]);
    expect(encoded.records.map((entry) => [entry.blockIndex, entry.recordOffset])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it('compresses each block on its own with gzip by default', async () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      record(`r${i}`, { id: `r${i}`, pad: 'x'.repeat(40) })
    );
    const encoded = await encodeLogRecordBlocks(records, { maxUncompressedBlockBytes: 120 });
    expect(encoded.compression).toBe('gzip_block');
    expect(encoded.blocks.length).toBeGreaterThan(1);
    let offset = 0;
    for (const block of encoded.blocks) {
      expect(block.compressedOffset).toBe(offset);
      expect(encoded.body[block.compressedOffset]).toBe(0x1f);
      expect(encoded.body[block.compressedOffset + 1]).toBe(0x8b);
      expect(block.compressedLength).not.toBe(block.uncompressedLength);
      offset += block.compressedLength;
    }
    expect(offset).toBe(encoded.body.byteLength);
    for (const [index, entry] of encoded.records.entries()) {
      const block = encoded.blocks[entry.blockIndex];
      if (!block) throw new Error('expected a block');
      await expect(
        decodeLogRecordFromBlock(encoded.body, block, entry, 'gzip_block')
      ).resolves.toEqual(records[index]?.payload);
    }
  });

  it('splits at 256 KiB of text by default', async () => {
    const big = (id: string) => record(id, { id, pad: 'x'.repeat(100_000) });
    const encoded = await encodeLogRecordBlocks([big('a'), big('b'), big('c')], {
      compression: 'none',
    });
    expect(encoded.blocks.map((block) => block.recordCount)).toEqual([2, 1]);
    const exact = await encodeLogRecordBlocks([big('a'), big('b')], {
      compression: 'none',
      maxUncompressedBlockBytes: encoded.blocks[0]?.uncompressedLength ?? 0,
    });
    expect(exact.blocks.map((block) => block.recordCount)).toEqual([2]);
  });

  it('measures lines in bytes, not characters', async () => {
    const encoded = await encodeLogRecordBlocks(
      [record('é', { id: 'é' }), record('ü', { id: 'ü' })],
      {
        compression: 'none',
      }
    );
    const first = encoded.records[0];
    const second = encoded.records[1];
    expect(first?.recordLength).toBe(new TextEncoder().encode('{"id":"é"}').byteLength);
    expect(second?.recordOffset).toBe((first?.recordLength ?? 0) + 1);
    expect(encoded.blocks[0]?.uncompressedLength).toBe(encoded.body.byteLength);
  });
});

describe('decodeLogRecordFromBlock', () => {
  it('reads any record of a block by its offsets', async () => {
    for (const compression of ['none', 'gzip_block'] as const) {
      const records = [record('a'), record('b', { id: 'b', n: [1, 2] }), record('c')];
      const encoded = await encodeLogRecordBlocks(records, { compression });
      for (const [index, entry] of encoded.records.entries()) {
        const block = encoded.blocks[0];
        if (!block) throw new Error('expected a block');
        await expect(
          decodeLogRecordFromBlock(encoded.body, block, entry, compression)
        ).resolves.toEqual(records[index]?.payload);
      }
    }
  });

  it('refuses a record that belongs to another block', async () => {
    const encoded = await encodeLogRecordBlocks([record('a'), record('b')], {
      compression: 'none',
      maxUncompressedBlockBytes: 11,
    });
    const [first, second] = encoded.blocks;
    const [entry] = encoded.records;
    if (!first || !second || !entry) throw new Error('expected blocks');
    await expect(decodeLogRecordFromBlock(encoded.body, second, entry, 'none')).rejects.toThrow(
      'log_record_block_mismatch'
    );
    await expect(decodeLogRecordFromBlock(encoded.body, first, entry, 'none')).resolves.toEqual({
      id: 'a',
    });
  });

  it('reads a block from its own bytes in a body of several blocks', async () => {
    const encoded = await encodeLogRecordBlocks([record('a'), record('b'), record('c')], {
      compression: 'gzip_block',
      maxUncompressedBlockBytes: 11,
    });
    const block = encoded.blocks[2];
    const entry = encoded.records[2];
    if (!block || !entry) throw new Error('expected a block');
    await expect(
      decodeLogRecordFromBlock(encoded.body, block, entry, 'gzip_block')
    ).resolves.toEqual({ id: 'c' });
  });
});
