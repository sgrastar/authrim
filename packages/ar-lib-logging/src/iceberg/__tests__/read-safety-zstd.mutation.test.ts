import { describe, expect, it } from 'vitest';
import { safeZstd } from '../read-safety.js';
import { bytesOf } from './binary-builders.js';
import { IcebergBudgetError } from '../types.js';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const le = (value: number, bytes: number): number[] =>
  Array.from({ length: bytes }, (_, i) => Math.floor(value / 2 ** (8 * i)) & 0xff);

/** A block: last flag, type (0 raw, 1 RLE, 2 compressed, 3 reserved) and its size field. */
function block(type: number, size: number, last: boolean, content?: number[]): number[] {
  const header = (last ? 1 : 0) | (type << 1) | (size << 3);
  const body = content ?? (type === 1 ? [7] : bytesOf(type === 2 ? size : size, 0));
  return [...le(header, 3), ...body];
}

interface FrameOptions {
  descriptor: number;
  window?: number;
  dictionary?: number[];
  fcs?: number[];
  blocks?: number[][];
  checksum?: boolean;
}

function frame(options: FrameOptions): number[] {
  return [
    ...MAGIC,
    options.descriptor,
    ...(options.window === undefined ? [] : [options.window]),
    ...(options.dictionary ?? []),
    ...(options.fcs ?? []),
    ...(options.blocks ?? [block(0, 0, true)]).flat(),
    ...(options.checksum ? [1, 2, 3, 4] : []),
  ];
}

/** A single-segment frame with a one-byte content size. */
const single = (size: number, blocks?: number[][]): number[] =>
  frame({ descriptor: 0x20, fcs: [size], blocks: blocks ?? [block(0, size, true)] });

const run = (bytes: number[], expected: number, limit?: number): number =>
  safeZstd(Uint8Array.from(bytes), expected, limit);

describe('safeZstd', () => {
  it('accepts a frame of exactly the expected size and reports its allocation', () => {
    expect(run(single(5), 5)).toBe(5);
    expect(run(single(0), 0)).toBe(0);
    expect(run(single(200), 200)).toBe(200);
  });

  it('refuses a frame that is larger or smaller than the page header says', () => {
    expect(() => run(single(5), 4)).toThrow('ZSTD frame allocation exceeds decoded budget');
    expect(() => run(single(5), 6)).toThrow('ZSTD output length differs from Parquet page header');
    expect(() => run(single(5), 0)).toThrow(IcebergBudgetError);
  });

  it('reads frame content sizes of one, two, four and eight bytes', () => {
    const sized = (flag: number, fcs: number[], single_: boolean, expected: number): number[] =>
      frame({
        descriptor: (flag << 6) | (single_ ? 0x20 : 0),
        window: single_ ? undefined : 0,
        fcs,
        blocks: [block(0, expected, true)],
      });
    expect(run(sized(0, [9], true, 9), 9)).toBe(9);
    expect(run(sized(1, le(300 - 256, 2), true, 300), 300)).toBeGreaterThan(0);
    expect(run(sized(2, le(70_000, 4), true, 70_000), 70_000)).toBeGreaterThan(0);
    expect(() => run(sized(2, le(70_001, 4), true, 70_000), 70_000)).toThrow(IcebergBudgetError);
    expect(run(sized(3, [...le(5, 8)], true, 5), 5)).toBe(5);
    expect(() => run(sized(3, [...le(6, 8)], true, 5), 5)).toThrow(IcebergBudgetError);
    expect(run(sized(1, le(0, 2), true, 256), 256)).toBeGreaterThan(0);
    expect(() => run(sized(1, le(0, 2), true, 256), 255)).toThrow(IcebergBudgetError);
    expect(run(sized(0, [], false, 4), 4, 4096)).toBeGreaterThan(0);
  });

  it('refuses a content size the buffer does not hold', () => {
    const truncated = frame({ descriptor: 0x20 | (2 << 6), fcs: [1, 2], blocks: [] });
    expect(() => run(truncated, 5)).toThrow('Invalid bounded binary length');
  });

  it('refuses frames with a bad magic, reserved flags or an external dictionary', () => {
    expect(() => run([0, 0, 0, 0, 0], 0)).toThrow('Invalid ZSTD frame magic');
    expect(() => run([0x28, 0xb5, 0x2f, 0xfc, 0x20, 0, 1, 0, 0], 0)).toThrow(
      'Invalid ZSTD frame magic'
    );
    for (const descriptor of [0x28, 0x30, 0x38, 0x08, 0x10]) {
      expect(() => run(frame({ descriptor: descriptor | 0x20, fcs: [0] }), 0)).toThrow(
        'Unsupported ZSTD frame flags'
      );
    }
    for (const [id, dictionary] of [
      [1, [1]],
      [2, [1, 0]],
      [3, [1, 0, 0, 0]],
    ] as const) {
      expect(() =>
        run(frame({ descriptor: 0x20 | id, dictionary: [...dictionary], fcs: [0] }), 0)
      ).toThrow('External ZSTD dictionary is unsupported');
      expect(
        run(
          frame({
            descriptor: 0x20 | id,
            dictionary: bytesOf(dictionary.length, 0),
            fcs: [0],
          }),
          0
        )
      ).toBe(0);
    }
    expect(() =>
      run(frame({ descriptor: 0x20 | 3, dictionary: [0, 0, 0, 1], fcs: [0] }), 0)
    ).toThrow('External ZSTD dictionary is unsupported');
  });

  it('skips skippable frames and ignores them when counting output', () => {
    const skippable = (nibble: number, payload: number[]) => [
      ...le(0x184d2a50 + nibble, 4),
      ...le(payload.length, 4),
      ...payload,
    ];
    expect(run([...skippable(0, [1, 2, 3]), ...single(2)], 2)).toBe(2);
    expect(run([...skippable(15, []), ...single(2), ...skippable(3, [9])], 2)).toBe(2);
    expect(() => run(skippable(0, [1, 2, 3]).slice(0, -1), 0)).toThrow(
      'Invalid bounded binary length'
    );
    expect(run(skippable(0, [1]), 0)).toBe(0);
  });

  it('adds up concatenated frames and refuses more than expected', () => {
    expect(run([...single(3), ...single(4)], 7, 100)).toBe(7);
    expect(() => run([...single(3), ...single(4)], 6, 100)).toThrow(
      'ZSTD concatenated frames exceed decoded budget'
    );
    expect(() => run([...single(3), ...single(4)], 8, 100)).toThrow(
      'ZSTD output length differs from Parquet page header'
    );
  });

  it('reads blocks of every kind and refuses a reserved or oversized one', () => {
    expect(run(single(4, [block(1, 4, true)]), 4)).toBe(4);
    expect(run(single(3, [block(0, 1, false), block(0, 2, true)]), 3)).toBe(3);
    expect(() => run(single(3, [block(3, 1, true, [0])]), 3)).toThrow('Invalid ZSTD block');
    expect(() => run(single(3, [block(0, 128 * 1024 + 1, true, [])]), 3)).toThrow(
      'Invalid ZSTD block'
    );
    expect(() => run(single(3, [block(0, 5, true, [1])]), 3)).toThrow(
      'Invalid bounded binary length'
    );
    const compressed = block(2, 4, true, [1, 2, 3, 4]);
    expect(run(single(4, [compressed]), 4)).toBeGreaterThan(0);
  });

  it('reads a four-byte checksum after the last block', () => {
    expect(
      run(frame({ descriptor: 0x24, fcs: [2], blocks: [block(0, 2, true)], checksum: true }), 2)
    ).toBe(2);
    expect(() =>
      run(frame({ descriptor: 0x24, fcs: [2], blocks: [block(0, 2, true)] }), 2)
    ).toThrow('Invalid bounded binary length');
  });

  it('bounds the window of frames without a single segment', () => {
    const windowed = (window: number, content: number): number[] =>
      frame({ descriptor: 0x00, window, blocks: [block(1, content, true)] });
    expect(run(windowed(0, 10), 10, 1 << 20)).toBeGreaterThan(0);
    expect(run(windowed(0x00, 10), 10, 1024 + 10)).toBeGreaterThan(0);
    expect(() => run(windowed(0x00, 10), 10, 1023)).toThrow(
      'ZSTD frame allocation exceeds decoded budget'
    );
    expect(() => run(windowed(0x08, 10), 10, 2047)).toThrow(IcebergBudgetError);
    expect(() => run(windowed(0x01, 10), 10, 1151)).toThrow(IcebergBudgetError);
    expect(() => run(windowed(0xa0, 10), 10, 1 << 20)).toThrow(IcebergBudgetError);
    expect(run(windowed(0x50, 10), 10, 1 << 21)).toBeGreaterThan(0);
  });

  it('reserves the output and window of an unknown-size frame before decoding', () => {
    const unknown = (blocks: number[][], window = 0): number[] =>
      frame({ descriptor: 0x00, window, blocks });
    expect(run(unknown([block(0, 100, true)]), 100, 100 + 1024)).toBeGreaterThan(0);
    expect(() => run(unknown([block(0, 100, true)]), 100, 1023 + 100)).toThrow(IcebergBudgetError);
    expect(() => run(unknown([block(0, 2000, true)]), 2000, 1500)).toThrow(
      'ZSTD unknown-size output exceeds budget'
    );
    expect(() => run(unknown([block(0, 1500, false), block(0, 1500, true)]), 3000, 2500)).toThrow(
      'ZSTD unknown-size output exceeds budget'
    );
    expect(() => run(unknown([block(0, 2000, true)]), 2000, 2000)).toThrow(
      'ZSTD output/window allocation budget exceeded'
    );
    expect(run(unknown([block(0, 10, true)]), 10, 1034)).toBe(1034);
    expect(() => run(unknown([block(0, 10, true)]), 10, 1033)).toThrow(
      'ZSTD output/window allocation budget exceeded'
    );
    const compressed = unknown([block(2, 10, true, bytesOf(10, 0))]);
    expect(() => run(compressed, 10, 1024 + 1024)).not.toThrow();
    expect(() => run(compressed, 10, 1024 + 1023)).toThrow(IcebergBudgetError);
    const rle = unknown([block(1, 10, true)]);
    expect(() => run(rle, 10, 1024 + 10)).not.toThrow();
    expect(() => run(rle, 10, 1024 + 9)).toThrow(IcebergBudgetError);
  });

  it('adds allocations across frames against the limit', () => {
    expect(run([...single(3), ...single(4)], 7, 7)).toBe(7);
    expect(() => run([...single(3), ...single(4)], 7, 6)).toThrow(
      'ZSTD output/window allocation budget exceeded'
    );
  });
});
