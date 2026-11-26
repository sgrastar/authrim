import { describe, expect, it } from 'vitest';
import { safeAvro } from '../read-safety.js';
import { IcebergBudgetError } from '../types.js';
import {
  SYNC,
  avroBytes,
  avroFile,
  manyEntries,
  text,
  zigzagVarint,
  bytesOf,
} from './binary-builders.js';

const long = (value: number): number[] => zigzagVarint(value);
const record = (...fields: Array<[string, unknown]>) => ({
  type: 'record',
  name: 'r',
  fields: fields.map(([name, type]) => ({ name, type })),
});
const rowsOf = (count: number, row: number[]): number[][] =>
  Array.from({ length: count }, () => row);

function schemaOf(value: unknown): Uint8Array {
  return avroFile({ schema: value });
}

describe('safeAvro: file structure', () => {
  const simple = record(['a', 'long']);

  it('measures a small file: rows, nodes and the bytes charged to the budget', () => {
    const file = avroFile({ schema: simple, blocks: [{ rows: [long(1), long(2)] }] });
    const schemaBytes = JSON.stringify(simple).length;
    const metrics = safeAvro(file);
    expect(metrics).toStrictEqual({
      rows: 2,
      nodes: 4,
      containerEntries: 0,
      stringBytes: 'avro.schema'.length + schemaBytes,
      binaryBytes: 0,
      schemaBytes,
      estimatedDecodedBytes:
        4 * 64 + ('avro.schema'.length + schemaBytes) * 2 + schemaBytes * 32 + 1 * 128,
    });
  });

  it('reads several blocks, counting every row', () => {
    const file = avroFile({
      schema: simple,
      blocks: [{ rows: rowsOf(3, long(7)) }, { rows: rowsOf(4, long(7)) }],
    });
    expect(safeAvro(file).rows).toBe(7);
  });

  it('reads a file with no blocks', () => {
    expect(safeAvro(schemaOf(simple)).rows).toBe(0);
  });

  it('refuses a file that does not start with the Avro magic', () => {
    expect(() => safeAvro(avroFile({ schema: simple, magic: text('Obj\u0002') }))).toThrow(
      'Invalid Iceberg Avro magic'
    );
    expect(() => safeAvro(avroFile({ schema: simple, magic: text('Xbj\u0001') }))).toThrow(
      'Invalid Iceberg Avro magic'
    );
    expect(() => safeAvro(Uint8Array.from([]))).toThrow('Invalid bounded binary length');
  });

  it('accepts a null codec and refuses any other', () => {
    expect(() =>
      safeAvro(avroFile({ schema: simple, header: { 'avro.codec': text('null') } }))
    ).not.toThrow();
    expect(() =>
      safeAvro(avroFile({ schema: simple, header: { 'avro.codec': text('') } }))
    ).not.toThrow();
    for (const codec of ['deflate', 'snappy', 'zstandard', 'NULL']) {
      expect(() =>
        safeAvro(avroFile({ schema: simple, header: { 'avro.codec': text(codec) } }))
      ).toThrow('Compressed Avro manifest is not supported by the bounded reader');
    }
  });

  it('refuses a missing schema, and a schema over 64 KiB', () => {
    expect(() => safeAvro(avroFile({ schema: simple, noSchema: true }))).toThrow(
      'Avro schema budget exceeded'
    );
    const padded = (length: number) => ({ ...simple, doc: 'x'.repeat(length) });
    const base = JSON.stringify(padded(0)).length;
    expect(() => safeAvro(schemaOf(padded(64 * 1024 - base)))).not.toThrow();
    expect(() => safeAvro(schemaOf(padded(64 * 1024 - base + 1)))).toThrow(
      'Avro schema budget exceeded'
    );
  });

  it('counts and bounds the other schema strings in the header', () => {
    const extra = text('x'.repeat(10));
    const metrics = safeAvro(
      avroFile({ schema: simple, header: { schema: extra, 'iceberg.schema': extra } })
    );
    expect(metrics.schemaBytes).toBe(JSON.stringify(simple).length + 20);
    const big = Array.from({ length: 64 * 1024 + 1 }, () => 120);
    for (const name of ['schema', 'iceberg.schema']) {
      expect(() => safeAvro(avroFile({ schema: simple, header: { [name]: big } }))).toThrow(
        IcebergBudgetError
      );
    }
    const ok = Array.from({ length: 64 * 1024 }, () => 120);
    expect(() => safeAvro(avroFile({ schema: simple, header: { schema: ok } }))).not.toThrow();
  });

  it('bounds the header entries, per block and in total', () => {
    expect(() => safeAvro(avroFile({ schema: simple, header: manyEntries(63) }))).not.toThrow();
    expect(() => safeAvro(avroFile({ schema: simple, header: manyEntries(64) }))).toThrow(
      'Avro header budget exceeded'
    );
    expect(() => safeAvro(avroFile({ schema: simple, header: manyEntries(70) }))).toThrow(
      'Avro header budget exceeded'
    );
    const file = avroFile({ schema: simple, header: manyEntries(10), negativeHeader: true });
    expect(safeAvro(file).estimatedDecodedBytes % 64).toBeGreaterThanOrEqual(0);
    const total = (blocks: number, perBlock: number): Uint8Array => {
      const entry = (i: number) => [...avroBytes(text(`k${i}`)), ...avroBytes([1])];
      const schemaEntry = [
        ...avroBytes(text('avro.schema')),
        ...avroBytes(text(JSON.stringify(simple))),
      ];
      const out = [...text('Obj\u0001')];
      for (let b = 0; b < blocks; b += 1) {
        const entries = Array.from({ length: perBlock }, (_, i) => entry(b * 100 + i)).flat();
        const first = b === 0 ? schemaEntry : [];
        out.push(...long(perBlock + (b === 0 ? 1 : 0)), ...first, ...entries);
      }
      out.push(...long(0), ...SYNC);
      return Uint8Array.from(out);
    };
    expect(() => safeAvro(total(2, 31))).not.toThrow();
    expect(() => safeAvro(total(2, 32))).toThrow('Avro header budget exceeded');
  });

  it('reads a header map written with a negative count and a byte size', () => {
    const metrics = safeAvro(avroFile({ schema: simple, negativeHeader: true }));
    expect(metrics.schemaBytes).toBe(JSON.stringify(simple).length);
  });

  it('bounds rows per block and in total, and checks block size and sync', () => {
    const row = long(1);
    expect(() =>
      safeAvro(avroFile({ schema: simple, blocks: [{ rows: rowsOf(1000, row) }] }))
    ).not.toThrow();
    expect(() =>
      safeAvro(avroFile({ schema: simple, blocks: [{ rows: rowsOf(1, row), count: 10_001 }] }))
    ).toThrow('Avro manifest row budget exceeded');
    expect(() =>
      safeAvro(avroFile({ schema: simple, blocks: [{ rows: rowsOf(1, row), count: -1 }] }))
    ).toThrow('Avro manifest row budget exceeded');
    expect(
      safeAvro(
        avroFile({
          schema: simple,
          blocks: [{ rows: rowsOf(5000, row) }, { rows: rowsOf(5000, row) }],
        })
      ).rows
    ).toBe(10_000);
    expect(() =>
      safeAvro(
        avroFile({
          schema: simple,
          blocks: [
            { rows: rowsOf(5000, row) },
            { rows: rowsOf(5000, row) },
            { rows: rowsOf(1, row) },
          ],
        })
      )
    ).toThrow('Avro manifest row budget exceeded');
    expect(() =>
      safeAvro(avroFile({ schema: simple, blocks: [{ rows: rowsOf(1, row), extra: [1] }] }))
    ).toThrow('Avro block trailing data');
    expect(() =>
      safeAvro(
        avroFile({
          schema: simple,
          blocks: [{ rows: rowsOf(1, row), sync: SYNC.map((b) => b ^ 1) }],
        })
      )
    ).toThrow('Avro sync mismatch');
    expect(() =>
      safeAvro(
        avroFile({
          schema: simple,
          blocks: [{ rows: rowsOf(1, row), sync: SYNC.slice(0, 15).concat(0) }],
        })
      )
    ).toThrow('Avro sync mismatch');
  });
});

describe('safeAvro: schemas', () => {
  const nest = (depth: number, leaf: unknown = 'long'): unknown => {
    let value = leaf;
    for (let i = 0; i < depth; i += 1) value = { type: 'array', items: value };
    return value;
  };

  it('refuses schemas nested deeper than 16 levels', () => {
    expect(() => safeAvro(schemaOf(nest(16)))).not.toThrow();
    expect(() => safeAvro(schemaOf(nest(17)))).toThrow('Avro schema depth exceeded');
    const maps = (depth: number): unknown => {
      let value: unknown = 'long';
      for (let i = 0; i < depth; i += 1) value = { type: 'map', values: value };
      return value;
    };
    expect(() => safeAvro(schemaOf(maps(16)))).not.toThrow();
    expect(() => safeAvro(schemaOf(maps(17)))).toThrow('Avro schema depth exceeded');
    const unions = (depth: number): unknown => {
      let value: unknown = 'long';
      for (let i = 0; i < depth; i += 1) value = [value];
      return value;
    };
    expect(() => safeAvro(schemaOf(unions(16)))).not.toThrow();
    expect(() => safeAvro(schemaOf(unions(17)))).toThrow('Avro schema depth exceeded');
    const records = (depth: number): unknown => {
      let value: unknown = 'long';
      for (let i = 0; i < depth; i += 1) value = record(['f', value]);
      return value;
    };
    expect(() => safeAvro(schemaOf(records(16)))).not.toThrow();
    expect(() => safeAvro(schemaOf(records(17)))).toThrow('Avro schema depth exceeded');
  });

  it('refuses unions of more than 8 branches', () => {
    expect(() => safeAvro(schemaOf(Array.from({ length: 8 }, () => 'long')))).not.toThrow();
    expect(() => safeAvro(schemaOf(Array.from({ length: 9 }, () => 'long')))).toThrow(
      'Invalid Avro union'
    );
  });

  it('refuses records of more than 64 fields, or whose fields are not objects', () => {
    const fields = (count: number) =>
      Array.from({ length: count }, (_, i) => ['f' + i, 'long'] as [string, unknown]);
    expect(() => safeAvro(schemaOf(record(...fields(64))))).not.toThrow();
    expect(() => safeAvro(schemaOf(record(...fields(65))))).toThrow('Invalid Avro schema fields');
    expect(() => safeAvro(schemaOf({ type: 'record', name: 'r', fields: 'x' }))).toThrow(
      'Invalid Avro schema fields'
    );
    for (const bad of [5, null, 'long', [1]]) {
      expect(() => safeAvro(schemaOf({ type: 'record', name: 'r', fields: [bad] }))).toThrow(
        'Invalid Avro field'
      );
    }
  });

  it('refuses a schema that is not a type', () => {
    for (const bad of [5, null, true]) {
      expect(() => safeAvro(schemaOf(bad))).toThrow('Invalid Avro schema');
    }
    expect(() => safeAvro(schemaOf('long'))).not.toThrow();
  });

  it('visits the item and value types of arrays and maps', () => {
    expect(() => safeAvro(schemaOf({ type: 'array', items: 5 }))).toThrow('Invalid Avro schema');
    expect(() => safeAvro(schemaOf({ type: 'map', values: 5 }))).toThrow('Invalid Avro schema');
    expect(() => safeAvro(schemaOf(record(['f', { type: 'array', items: 5 }])))).toThrow(
      'Invalid Avro schema'
    );
  });
});

describe('safeAvro: data', () => {
  const read = (schema: unknown, ...rows: number[][]) =>
    safeAvro(avroFile({ schema, blocks: [{ rows }] }));

  it('skips every primitive type with its own size', () => {
    const schema = record(
      ['n', 'null'],
      ['b', 'boolean'],
      ['i', 'int'],
      ['l', 'long'],
      ['f', 'float'],
      ['d', 'double'],
      ['by', 'bytes'],
      ['s', 'string']
    );
    const row = [
      1,
      ...long(300),
      ...long(-70_000),
      1,
      2,
      3,
      4,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      ...avroBytes([9, 9, 9]),
      ...avroBytes(text('hello')),
    ];
    const metrics = read(schema, row);
    expect(metrics.binaryBytes).toBe(3);
    expect(metrics.stringBytes).toBe(
      'avro.schema'.length + JSON.stringify(schema).length + 'hello'.length
    );
    expect(metrics.nodes).toBe(9);
  });

  it('refuses data that ends early', () => {
    expect(() => read(record(['f', 'float']), [1, 2, 3])).toThrow('Invalid bounded binary length');
    expect(() => read(record(['d', 'double']), [1, 2, 3, 4, 5, 6, 7])).toThrow(
      'Invalid bounded binary length'
    );
  });

  it('follows a union branch, and refuses one that does not exist', () => {
    const schema = record(['u', ['null', 'string']]);
    expect(read(schema, [...long(0)]).nodes).toBe(3);
    expect(read(schema, [...long(1), ...avroBytes(text('abc'))]).stringBytes).toBeGreaterThan(3);
    expect(() => read(schema, [...long(2), 0, 0, 0])).toThrow('Invalid Avro union selection');
    expect(() => read(schema, [...long(-1)])).toThrow('Invalid bounded Avro length');
  });

  it('skips fixed values of up to 4096 bytes', () => {
    const fixed = (size: number) => ({ type: 'fixed', name: 'fx', size });
    const metrics = read(record(['x', fixed(4)]), [1, 2, 3, 4]);
    expect(metrics.binaryBytes).toBe(4);
    expect(() => read(record(['x', fixed(4096)]), bytesOf(4096, 0))).not.toThrow();
    expect(() => read(record(['x', fixed(4097)]), bytesOf(4097, 0))).toThrow('Invalid Avro fixed');
    expect(() =>
      read(record(['x', { type: 'fixed', name: 'fx', size: '4' }]), [1, 2, 3, 4])
    ).toThrow('Invalid Avro fixed');
  });

  it('skips arrays and maps, counting entries, keys and nodes', () => {
    const array = record(['a', { type: 'array', items: 'long' }]);
    const arrayRow = [...long(3), ...long(1), ...long(2), ...long(3), ...long(0)];
    const arrayMetrics = read(array, arrayRow);
    expect(arrayMetrics.containerEntries).toBe(3);
    expect(arrayMetrics.nodes).toBe(2 + 3);
    expect(read(array, [...long(0)]).containerEntries).toBe(0);
    expect(
      read(array, [...long(1), ...long(1), ...long(2), ...long(1), ...long(2), ...long(0)])
        .containerEntries
    ).toBe(3);

    const map = record(['m', { type: 'map', values: 'long' }]);
    const mapRow = [
      ...long(2),
      ...avroBytes(text('k1')),
      ...long(1),
      ...avroBytes(text('key2')),
      ...long(2),
      ...long(0),
    ];
    const mapMetrics = read(map, mapRow);
    expect(mapMetrics.containerEntries).toBe(2);
    expect(mapMetrics.nodes).toBe(2 + 2 + 2);
    expect(mapMetrics.stringBytes).toBe(
      'avro.schema'.length + JSON.stringify(map).length + 'k1'.length + 'key2'.length
    );
  });

  it('skips arrays written in blocks with a negative count and a byte size', () => {
    const array = record(['a', { type: 'array', items: 'long' }]);
    const block = [...long(1), ...long(2)];
    const row = [...long(-2), ...long(block.length), ...block, ...long(0)];
    expect(read(array, row).containerEntries).toBe(2);
    const map = record(['m', { type: 'map', values: 'long' }]);
    const entries = [...avroBytes(text('k')), ...long(1)];
    const mapRow = [...long(-1), ...long(entries.length), ...entries, ...long(0)];
    expect(read(map, mapRow).containerEntries).toBe(1);
  });

  it('bounds the entries of one array block and of all of them', () => {
    const array = record(['a', { type: 'array', items: 'null' }]);
    const items = (count: number) => [...long(count), ...long(0)];
    expect(() => read(array, items(4096))).not.toThrow();
    expect(() => read(array, items(4097))).toThrow('Avro collection budget exceeded');
    const manyBlocks = (blocks: number): number[] => [
      ...Array.from({ length: blocks }, () => long(4096)).flat(),
      ...long(0),
    ];
    expect(() => read(array, manyBlocks(48))).not.toThrow();
    expect(() => read(array, manyBlocks(49))).toThrow('Avro collection budget exceeded');
  });

  it('skips a named type by its definition, and a record nested in a record', () => {
    const named = {
      type: 'record',
      name: 'outer',
      fields: [
        {
          name: 'first',
          type: { type: 'record', name: 'point', fields: [{ name: 'x', type: 'long' }] },
        },
        { name: 'second', type: 'point' },
      ],
    };
    const metrics = read(named, [...long(1), ...long(2)]);
    expect(metrics.nodes).toBe(6);
    expect(() => read(record(['x', 'unknown_type']), [1])).toThrow('Unsupported bounded Avro type');
    expect(() => read(record(['x', { type: 'enum', name: 'e', symbols: ['a'] }]), [0])).toThrow(
      'Unsupported bounded Avro type'
    );
  });

  it('bounds the depth of decoded values and the number of nodes', () => {
    const recursive = {
      type: 'record',
      name: 'node',
      fields: [{ name: 'next', type: ['null', 'node'] }],
    };
    const chain = (links: number): number[] => [
      ...Array.from({ length: links }, () => [...long(1)]).flat(),
      ...long(0),
    ];
    expect(() => read(recursive, chain(5))).not.toThrow();
    expect(() => read(recursive, chain(40))).toThrow('Avro decoded value budget exceeded');

    const nodes = record(['a', { type: 'array', items: 'null' }]);
    const items = (count: number) => [...long(count), ...long(0)];
    const rows = (count: number) => Array.from({ length: count }, () => items(4000));
    expect(read(nodes, ...rows(49)).nodes).toBe(49 * 4002);
    expect(() => read(nodes, ...rows(50))).toThrow('Avro decoded value budget exceeded');
  });
});
