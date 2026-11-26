import { describe, expect, it } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { serializeTCompactProtocol } from 'hyparquet-writer/src/thrift.js';
import { safeParquetPages } from '../read-safety.js';
import { IcebergBudgetError } from '../types.js';
import { varint, bytesOf } from './binary-builders.js';

const PLAIN = 0;
const RLE = 3;
const DELTA = 5;
const RLE_DICTIONARY = 8;

function header(fields: Record<string, unknown>): number[] {
  const writer = new ByteWriter();
  serializeTCompactProtocol(writer, fields);
  return [...writer.getBytes()];
}

interface DataPage {
  values: number;
  encoding?: number;
  payload?: number[];
  unc?: number;
  comp?: number;
  defEncoding?: number;
}

/** A v1 data page: its header followed by the payload. */
function data(page: DataPage): number[] {
  const payload = page.payload ?? [];
  return [
    ...header({
      field_1: 0,
      field_2: page.unc ?? payload.length,
      field_3: page.comp ?? payload.length,
      field_5: {
        field_1: page.values,
        field_2: page.encoding ?? PLAIN,
        field_3: page.defEncoding ?? RLE,
        field_4: RLE,
      },
    }),
    ...payload,
  ];
}

interface V2Page {
  values: number;
  nulls?: number;
  rows?: number;
  encoding?: number;
  defLevels?: number[];
  repBytes?: number;
  payload?: number[];
  unc?: number;
  compressed?: boolean;
}

function dataV2(page: V2Page): number[] {
  const defLevels = page.defLevels ?? [];
  const payload = [...defLevels, ...(page.payload ?? [])];
  return [
    ...header({
      field_1: 3,
      field_2: page.unc ?? payload.length,
      field_3: payload.length,
      field_8: {
        field_1: page.values,
        field_2: page.nulls ?? 0,
        field_3: page.rows ?? page.values,
        field_4: page.encoding ?? PLAIN,
        field_5: defLevels.length,
        field_6: page.repBytes ?? 0,
        ...(page.compressed === undefined ? {} : { field_7: page.compressed }),
      },
    }),
    ...payload,
  ];
}

function dictionary(values: number, payload: number[], encoding = PLAIN): number[] {
  return [
    ...header({
      field_1: 2,
      field_2: payload.length,
      field_3: payload.length,
      field_7: { field_1: values, field_2: encoding },
    }),
    ...payload,
  ];
}

const pages = (
  bytes: number[],
  rowLimit = 1000,
  decodedLimit = 1 << 20,
  codec = 'UNCOMPRESSED',
  column?: { type: string; optional: boolean; dictionaryValues?: number }
): number => safeParquetPages(Uint8Array.from(bytes), rowLimit, decodedLimit, codec, column);

const required = { type: 'INT32', optional: false };

describe('safeParquetPages: page headers and budgets', () => {
  it('reads no pages from no bytes, and adds up the decoded size of the pages it reads', () => {
    expect(pages([])).toBe(0);
    const one = data({ values: 2, payload: bytesOf(8, 0) });
    expect(pages(one)).toBe(8);
    expect(pages([...one, ...one])).toBe(16);
    expect(pages([...one, ...data({ values: 1, payload: [0, 0, 0, 0] })])).toBe(12);
  });

  it('refuses pages that decode to more than the budget, exactly', () => {
    const one = data({ values: 2, payload: bytesOf(8, 0) });
    expect(pages([...one, ...one], 1000, 16)).toBe(16);
    expect(() => pages([...one, ...one], 1000, 15)).toThrow('Parquet decoded byte budget exceeded');
    expect(() => pages(one, 1000, 7)).toThrow(IcebergBudgetError);
  });

  it('refuses a negative page size', () => {
    expect(() => pages(data({ values: 1, unc: -1, comp: 0 }))).toThrow('Invalid Parquet page size');
    expect(() => pages(data({ values: 1, unc: 0, comp: -1 }))).toThrow('Invalid Parquet page size');
    expect(pages(data({ values: 0, unc: 0, comp: 0 }))).toBe(0);
  });

  it('refuses more than 4096 pages', () => {
    const empty = data({ values: 0, unc: 0, comp: 0 });
    expect(pages(Array.from({ length: 4096 }, () => empty).flat(), 10, 100)).toBe(0);
    expect(() => pages(Array.from({ length: 4097 }, () => empty).flat(), 10, 100)).toThrow(
      'Parquet page budget exceeded'
    );
  });

  it('refuses a page without a value count, or with one beyond the row limit', () => {
    const noCount = header({ field_1: 0, field_2: 0, field_3: 0 });
    expect(() => pages(noCount)).toThrow('Parquet page value budget exceeded');
    expect(() => pages(data({ values: 11 }), 10)).toThrow('Parquet page value budget exceeded');
    expect(pages(data({ values: 10, payload: bytesOf(40, 0) }), 10)).toBe(40);
    expect(() => pages(data({ values: -1 }))).toThrow('Parquet page value budget exceeded');
    expect(pages(data({ values: 0 }))).toBe(0);
    const dict = dictionary(3, []);
    expect(() => pages(dict, 2)).toThrow('Parquet page value budget exceeded');
  });

  it('reads the count of a dictionary page and a v2 page as well', () => {
    expect(() => pages(dictionary(11, []), 10)).toThrow('Parquet page value budget exceeded');
    expect(() => pages(dataV2({ values: 11, rows: 1 }), 10)).toThrow(
      'Parquet page value budget exceeded'
    );
  });

  it('refuses a column chunk whose last page runs past its end', () => {
    expect(() => pages(data({ values: 1, unc: 4, comp: 4, payload: [0, 0, 0] }))).toThrow(
      'Parquet page exceeds column chunk'
    );
  });

  it('refuses codecs it cannot bound', () => {
    const page = data({ values: 0 });
    for (const codec of ['SNAPPY', 'UNCOMPRESSED', 'ZSTD']) {
      expect(() => pages(page, 10, 100, codec)).not.toThrow('Unsupported bounded Parquet codec');
    }
    for (const codec of ['GZIP', 'LZ4', 'BROTLI', '']) {
      expect(() => pages(page, 10, 100, codec)).toThrow('Unsupported bounded Parquet codec');
    }
  });
});

describe('safeParquetPages: v2 page bounds', () => {
  const ok = (overrides: Partial<V2Page> = {}): number[] =>
    dataV2({ values: 4, nulls: 1, rows: 4, payload: bytesOf(12, 0), ...overrides });

  it('accepts consistent bounds', () => {
    expect(pages(ok(), 4)).toBe(12);
    expect(pages(ok({ rows: 4, nulls: 4 }), 4)).toBe(12);
    expect(pages(ok({ nulls: 0 }), 4)).toBe(12);
  });

  it('refuses bounds that do not hold together', () => {
    const bad: Array<Partial<V2Page>> = [
      { rows: 5 },
      { rows: -1 },
      { nulls: -1 },
      { nulls: 5 },
      { repBytes: -1 },
      { repBytes: 13 },
    ];
    for (const overrides of bad) {
      expect(() => pages(ok(overrides), 4)).toThrow('Invalid Parquet v2 page bounds');
    }
    const longDefinitions = dataV2({ values: 1, nulls: 0, defLevels: [1, 2, 3], unc: 2 });
    expect(() => pages(longDefinitions, 4)).toThrow('Invalid Parquet v2 page bounds');
    const sum = dataV2({ values: 1, nulls: 0, defLevels: [1, 2], repBytes: 2, unc: 3 });
    expect(() => pages(sum, 4)).toThrow('Invalid Parquet v2 page bounds');
    const exact = dataV2({ values: 1, nulls: 0, defLevels: [1, 2], repBytes: 1, unc: 3 });
    expect(pages(exact, 4)).toBe(3);
  });
});

describe('safeParquetPages: page content', () => {
  const ints = (count: number): number[] => bytesOf(count * 4, 1);

  it('checks plain values of each primitive type against the page size', () => {
    expect(
      pages(data({ values: 3, payload: ints(3) }), 10, 1 << 20, 'UNCOMPRESSED', required)
    ).toBe(12);
    expect(
      pages(data({ values: 2, payload: bytesOf(16, 1) }), 10, 1 << 20, 'UNCOMPRESSED', {
        type: 'INT64',
        optional: false,
      })
    ).toBe(16);
    expect(() =>
      pages(data({ values: 3, payload: ints(2) }), 10, 1 << 20, 'UNCOMPRESSED', required)
    ).toThrow('Invalid bounded binary length');
    const strings = [2, 0, 0, 0, 97, 98, 1, 0, 0, 0, 99];
    expect(
      pages(data({ values: 2, payload: strings }), 10, 1 << 20, 'UNCOMPRESSED', {
        type: 'BYTE_ARRAY',
        optional: false,
      })
    ).toBe(11);
    expect(() =>
      pages(data({ values: 3, payload: strings }), 10, 1 << 20, 'UNCOMPRESSED', {
        type: 'BYTE_ARRAY',
        optional: false,
      })
    ).toThrow('Invalid bounded binary length');
    expect(() =>
      pages(data({ values: 1, payload: [0, 0, 0, 0] }), 10, 1 << 20, 'UNCOMPRESSED', {
        type: 'FLOAT',
        optional: false,
      })
    ).toThrow('Unsupported bounded Parquet primitive');
  });

  it('refuses a page whose stored size differs from its decoded size', () => {
    expect(() =>
      pages(
        data({ values: 1, unc: 8, comp: 4, payload: [0, 0, 0, 0] }),
        10,
        1 << 20,
        'UNCOMPRESSED',
        required
      )
    ).toThrow('Invalid decoded Parquet page length');
  });

  it('refuses value encodings it cannot bound', () => {
    expect(() =>
      pages(
        data({ values: 1, encoding: DELTA, payload: ints(1) }),
        10,
        1 << 20,
        'UNCOMPRESSED',
        required
      )
    ).toThrow('Unsupported bounded Parquet value encoding');
  });

  it('reads definition levels of an optional v1 column, which must be RLE encoded', () => {
    // two values, both present: RLE run of 2 with value 1, then two INT32 values.
    const levels = [2, 0, 0, 0, 4, 1];
    const payload = [...levels, ...ints(2)];
    const column = { type: 'INT32', optional: true };
    expect(pages(data({ values: 2, payload }), 10, 1 << 20, 'UNCOMPRESSED', column)).toBe(
      payload.length
    );
    // one present, one null: bit-packed run of 8 with bits 0b01 and one INT32 value.
    const sparse = [...[2, 0, 0, 0, 3, 0b01], ...ints(1)];
    expect(pages(data({ values: 2, payload: sparse }), 10, 1 << 20, 'UNCOMPRESSED', column)).toBe(
      sparse.length
    );
    expect(() =>
      pages(data({ values: 2, payload, defEncoding: PLAIN }), 10, 1 << 20, 'UNCOMPRESSED', column)
    ).toThrow('Unsupported definition level encoding');
    expect(() =>
      pages(
        data({ values: 2, payload: [...sparse, ...ints(1)] }),
        10,
        1 << 20,
        'UNCOMPRESSED',
        column
      )
    ).not.toThrow();
  });

  it('reads definition levels of a v2 page and checks its null count', () => {
    const column = { type: 'INT32', optional: true };
    const levels = [4, 1];
    const good = dataV2({ values: 2, nulls: 0, defLevels: levels, payload: ints(2) });
    expect(pages(good, 10, 1 << 20, 'UNCOMPRESSED', column)).toBe(10);
    const sparse = dataV2({ values: 2, nulls: 1, defLevels: [3, 0b01], payload: ints(1) });
    expect(pages(sparse, 10, 1 << 20, 'UNCOMPRESSED', column)).toBe(2 + 4);
    const lying = dataV2({ values: 2, nulls: 1, defLevels: levels, payload: ints(2) });
    expect(() => pages(lying, 10, 1 << 20, 'UNCOMPRESSED', column)).toThrow(
      'Parquet null count differs from definition levels'
    );
    const required_ = dataV2({ values: 2, nulls: 1, payload: ints(2) });
    expect(() => pages(required_, 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Parquet null count differs from definition levels'
    );
    const repeated = dataV2({ values: 2, nulls: 0, repBytes: 1, defLevels: [0], payload: ints(2) });
    expect(() => pages(repeated, 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Repeated Parquet fields are unsupported'
    );
  });

  it('reads an uncompressed v2 page of a compressed column as plain', () => {
    const page = dataV2({ values: 1, payload: ints(1), compressed: false });
    expect(pages(page, 10, 1 << 20, 'SNAPPY', required)).toBe(4);
  });
});

describe('safeParquetPages: dictionaries', () => {
  const dict = dictionary(3, bytesOf(12, 0));
  const indexes = (width: number, runBytes: number[], values: number): number[] =>
    data({ values, encoding: RLE_DICTIONARY, payload: [width, ...runBytes] });

  it('reads dictionary indexes within the dictionary', () => {
    // RLE run of 4 values of index 2, bit width 2.
    const page = indexes(2, [4 << 1, 2], 4);
    expect(pages([...dict, ...page], 10, 1 << 20, 'UNCOMPRESSED', required)).toBe(12 + 3);
    const preset = { type: 'INT32', optional: false, dictionaryValues: 3 };
    expect(pages(page, 10, 1 << 20, 'UNCOMPRESSED', preset)).toBe(3);
    // bit-packed run of 8 values at width 2, only the first four counted.
    const packed = indexes(2, [(1 << 1) | 1, 0b00_00_01_10, 0b00_00_00_00], 4);
    expect(() => pages([...dict, ...packed], 10, 1 << 20, 'UNCOMPRESSED', required)).not.toThrow();
  });

  it('refuses an index outside the dictionary', () => {
    const page = indexes(2, [4 << 1, 3], 4);
    expect(() => pages([...dict, ...page], 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Dictionary index outside dictionary'
    );
    const edge = indexes(2, [4 << 1, 2], 4);
    expect(() => pages([...dict, ...edge], 10, 1 << 20, 'UNCOMPRESSED', required)).not.toThrow();
    const packedOut = indexes(2, [(1 << 1) | 1, 0b00_00_00_11, 0], 4);
    expect(() => pages([...dict, ...packedOut], 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Dictionary index outside dictionary'
    );
    const hiddenPast = indexes(2, [(1 << 1) | 1, 0b00_00_00_00, 0b00_00_00_11], 4);
    expect(() =>
      pages([...dict, ...hiddenPast], 10, 1 << 20, 'UNCOMPRESSED', required)
    ).not.toThrow();
  });

  it('refuses a missing dictionary or a bit width over 32', () => {
    const page = indexes(2, [4 << 1, 0], 4);
    expect(() => pages(page, 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Invalid dictionary index encoding'
    );
    const wide = indexes(33, [4 << 1, 0, 0, 0, 0, 0], 4);
    expect(() => pages([...dict, ...wide], 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Invalid dictionary index encoding'
    );
    const widest = indexes(32, [4 << 1, 0, 0, 0, 0], 4);
    expect(() => pages([...dict, ...widest], 10, 1 << 20, 'UNCOMPRESSED', required)).not.toThrow();
  });

  it('accepts a zero bit width only for a dictionary with entries', () => {
    const page = indexes(0, [], 4);
    expect(() => pages([...dict, ...page], 10, 1 << 20, 'UNCOMPRESSED', required)).not.toThrow();
    const empty = dictionary(0, []);
    expect(() => pages([...empty, ...page], 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Dictionary is empty'
    );
    expect(() =>
      pages([...empty, ...indexes(0, [], 0)], 10, 1 << 20, 'UNCOMPRESSED', required)
    ).not.toThrow();
  });

  it('accepts only plain dictionary pages', () => {
    expect(() =>
      pages(dictionary(3, bytesOf(12, 0), DELTA), 10, 1 << 20, 'UNCOMPRESSED', required)
    ).toThrow('Unsupported dictionary encoding');
  });

  it('accepts the legacy dictionary encoding name for data pages too', () => {
    const page = data({ values: 4, encoding: 2, payload: [2, 4 << 1, 1] });
    expect(() => pages([...dict, ...page], 10, 1 << 20, 'UNCOMPRESSED', required)).not.toThrow();
  });

  it('refuses a run longer than the values that remain, and a run of nothing', () => {
    const tooLong = indexes(2, [...varint(12 << 1), 1], 4);
    expect(() => pages([...dict, ...tooLong], 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Parquet RLE run exceeds page value budget'
    );
    const empty = indexes(2, [0, 0], 4);
    expect(() => pages([...dict, ...empty], 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Parquet RLE run exceeds page value budget'
    );
    const exactly = indexes(2, [...varint(4 << 1), 1], 4);
    expect(() => pages([...dict, ...exactly], 10, 1 << 20, 'UNCOMPRESSED', required)).not.toThrow();
    const sevenOver = indexes(2, [(1 << 1) | 1, 0, 0], 1);
    expect(() =>
      pages([...dict, ...sevenOver], 10, 1 << 20, 'UNCOMPRESSED', required)
    ).not.toThrow();
    const eightOver = indexes(2, [(2 << 1) | 1, 0, 0, 0, 0], 1);
    expect(() => pages([...dict, ...eightOver], 10, 1 << 20, 'UNCOMPRESSED', required)).toThrow(
      'Parquet RLE run exceeds page value budget'
    );
  });
});

describe('safeParquetPages: Snappy pages', () => {
  const literal = (bytes: number[]): number[] => [
    ...varint(bytes.length),
    (bytes.length - 1) << 2,
    ...bytes,
  ];
  const snappyPage = (compressed: number[], unc: number): number[] =>
    data({ values: unc / 4, payload: compressed, unc });

  it('decompresses a literal page of the declared size', () => {
    const plain = bytesOf(8, 5);
    expect(pages(snappyPage(literal(plain), 8), 10, 1 << 20, 'SNAPPY', required)).toBe(8);
  });

  it('refuses a Snappy stream that declares another length', () => {
    const plain = bytesOf(8, 5);
    expect(() => pages(snappyPage(literal(plain), 12), 10, 1 << 20, 'SNAPPY', required)).toThrow(
      'Snappy decoded length differs from Parquet header'
    );
  });

  it('refuses a stream that produces more or less than it declares', () => {
    const declared = (count: number, body: number[]) => [...varint(count), ...body];
    const tooMuch = declared(4, [(8 - 1) << 2, ...bytesOf(8, 0)]);
    expect(() => pages(snappyPage(tooMuch, 4), 10, 1 << 20, 'SNAPPY', required)).toThrow(
      'Snappy payload exceeds decoded budget'
    );
    const tooLittle = declared(8, [(4 - 1) << 2, 0, 0, 0, 0]);
    expect(() => pages(snappyPage(tooLittle, 8), 10, 1 << 20, 'SNAPPY', required)).toThrow(
      'Invalid Snappy decoded length'
    );
  });

  it('reads copies with an offset inside what was produced', () => {
    // literal of 4, then a one-byte-offset copy of 4 from offset 4.
    const copy1 = [...varint(8), (4 - 1) << 2, 1, 2, 3, 4, ((4 - 4) << 2) | 1, 4];
    expect(pages(snappyPage(copy1, 8), 10, 1 << 20, 'SNAPPY', required)).toBe(8);
    // two-byte-offset copy: tag kind 2, length 4, offset 4.
    const copy2 = [...varint(8), (4 - 1) << 2, 1, 2, 3, 4, ((4 - 1) << 2) | 2, 4, 0];
    expect(pages(snappyPage(copy2, 8), 10, 1 << 20, 'SNAPPY', required)).toBe(8);
    // four-byte-offset copy: tag kind 3.
    const copy3 = [...varint(8), (4 - 1) << 2, 1, 2, 3, 4, ((4 - 1) << 2) | 3, 4, 0, 0, 0];
    expect(pages(snappyPage(copy3, 8), 10, 1 << 20, 'SNAPPY', required)).toBe(8);
  });

  it('refuses a copy from before the start or from beyond what was produced', () => {
    const beyond = [...varint(8), (4 - 1) << 2, 1, 2, 3, 4, ((4 - 4) << 2) | 1, 5];
    expect(() => pages(snappyPage(beyond, 8), 10, 1 << 20, 'SNAPPY', required)).toThrow(
      'Invalid Snappy copy offset'
    );
    const zero = [...varint(8), (4 - 1) << 2, 1, 2, 3, 4, ((4 - 1) << 2) | 2, 0, 0];
    expect(() => pages(snappyPage(zero, 8), 10, 1 << 20, 'SNAPPY', required)).toThrow(
      'Invalid Snappy copy offset'
    );
    const first = [...varint(8), ((4 - 4) << 2) | 1, 1];
    expect(() => pages(snappyPage(first, 8), 10, 1 << 20, 'SNAPPY', required)).toThrow(
      'Invalid Snappy copy offset'
    );
  });

  it('reads literals whose length is stored in extra bytes', () => {
    const long = bytesOf(64, 7);
    const stream = [...varint(64), 60 << 2, 63, ...long];
    expect(pages(snappyPage(stream, 64), 100, 1 << 20, 'SNAPPY', required)).toBe(64);
    const wide = [...varint(64), 61 << 2, 63, 0, ...long];
    expect(pages(snappyPage(wide, 64), 100, 1 << 20, 'SNAPPY', required)).toBe(64);
    const huge = [...varint(64), 61 << 2, 255, 255, ...long];
    expect(() => pages(snappyPage(huge, 64), 100, 1 << 20, 'SNAPPY', required)).toThrow(
      'Invalid bounded binary length'
    );
  });
});
