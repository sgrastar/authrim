import { describe, expect, it } from 'vitest';
import { readFlatFileWindow, type FlatColumnCursor } from '../flat-reader.js';
import { IcebergBudgetError } from '../types.js';
import { openArchive, type OpenedFile } from './flat-reader-harness.js';

type Profile = Awaited<ReturnType<typeof openArchive>>['profile'];

function copyOf(file: OpenedFile, change: (copy: OpenedFile) => void): OpenedFile {
  const copy = { ...file, metadata: structuredClone(file.metadata) };
  change(copy);
  return copy;
}

describe('window validation', () => {
  it('refuses a window that is not made of safe integers in order', async () => {
    const { file, profile } = await openArchive();
    const window = 'Invalid flat file row window';
    const bad: Array<[number, number]> = [
      [1.5, 4],
      [0, 4.5],
      [Number.NaN, 4],
      [0, Number.NaN],
      [-1, 4],
      [4, 3],
      [0, Number.POSITIVE_INFINITY],
      [2 ** 53, 2 ** 53 + 2],
    ];
    for (const [rowStart, rowEnd] of bad) {
      await expect(readFlatFileWindow({ file, profile, rowStart, rowEnd })).rejects.toThrow(window);
    }
    await expect(
      readFlatFileWindow({ file, profile, rowStart: 0, rowEnd: 10_001 })
    ).rejects.toBeInstanceOf(IcebergBudgetError);
    const empty = await readFlatFileWindow({ file, profile, rowStart: 3, rowEnd: 3 });
    expect(empty.rows).toEqual([]);
    expect(empty.nextRow).toBe(3);
    const wide = await readFlatFileWindow({ file, profile, rowStart: 0, rowEnd: 10_000 });
    expect(wide.rows).toHaveLength(8);
  });

  it('allows a window of any length when rows are selected', async () => {
    const { file, profile } = await openArchive();
    const result = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 50_000,
      select: { field: 'event_id', matches: () => true, maxMatches: 100 },
    });
    expect(result.rows).toHaveLength(8);
  });
});

describe('rows of a window', () => {
  it('returns the positions and every field of each row in the window', async () => {
    const { file, profile } = await openArchive();
    const result = await readFlatFileWindow({ file, profile, rowStart: 2, rowEnd: 4 });
    expect(result.nextRow).toBe(4);
    expect(result.rows.map((row) => row.position)).toEqual([2n, 3n]);
    expect(result.rows[0]?.values).toStrictEqual({
      schema_version: 1,
      storage_generation: 'new-generation',
      event_id: 'event-2',
      tenant_key: 'tenant-a',
      source_dataset: 'core.event_log',
      log_type: 'audit',
      event_at: 1793000000002n,
      ingested_at: 1793000001000n,
      expires_at: null,
      action: 'signin',
      result: 'success',
      severity: null,
      reason_code: null,
      request_id: null,
      subject_id: 'subject-even',
      client_id: null,
      resource_id: null,
      detail_ciphertext: 'encrypted-body',
      detail_key_version: '1',
      payload_hmac: 'a'.repeat(64),
    });
    expect(result.rows[1]?.values.event_id).toBe('event-3');
    expect(result.rows[1]?.values.subject_id).toBe('subject-odd');
  });

  it('returns only the projected fields, and nothing for an unknown one', async () => {
    const { file, profile } = await openArchive();
    const some = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 2,
      projection: ['event_id', 'event_at'],
    });
    expect(some.rows.map((row) => row.values)).toEqual([
      { event_id: 'event-0', event_at: 1793000000000n },
      { event_id: 'event-1', event_at: 1793000000001n },
    ]);
    const none = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 2,
      projection: ['unknown_field'],
    });
    expect(none.rows.map((row) => row.values)).toEqual([{}, {}]);
    expect(none.nextColumns).toEqual([]);
  });

  it('lists where each column was read, for continuing the window later', async () => {
    const { file, profile } = await openArchive();
    const result = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 2,
      projection: ['event_id', 'tenant_key'],
    });
    const group = file.metadata.row_groups[0];
    const offsetOf = (name: string): number => {
      const column = group?.columns.find(
        (item) => item.meta_data?.path_in_schema.join('.') === name
      );
      return Number(column?.meta_data?.data_page_offset);
    };
    const names = file.metadata.schema;
    const nameOf = (id: number): string =>
      String(names.find((element) => element.field_id === id)?.name);
    expect(result.nextColumns).toHaveLength(2);
    for (const cursor of result.nextColumns) {
      expect(cursor.groupIndex).toBe(0);
      expect(cursor.firstRow).toBe(0);
      expect(cursor.byteOffset).toBe(offsetOf(nameOf(cursor.fieldId)));
    }
    expect(result.nextColumns.map((cursor) => cursor.fieldId).sort()).toEqual(
      [profile.fieldIds.event_id, profile.fieldIds.tenant_key].sort()
    );
    const all = await readFlatFileWindow({ file, profile, rowStart: 0, rowEnd: 2 });
    expect(all.nextColumns).toHaveLength(20);
  });

  it('continues from the cursors of an earlier window to the same rows', async () => {
    const { file, profile } = await openArchive();
    const first = await readFlatFileWindow({ file, profile, rowStart: 0, rowEnd: 2 });
    const direct = await readFlatFileWindow({ file, profile, rowStart: 4, rowEnd: 6 });
    const resumed = await readFlatFileWindow({
      file,
      profile,
      rowStart: 4,
      rowEnd: 6,
      columns: first.nextColumns,
    });
    expect(resumed.rows).toStrictEqual(direct.rows);
  });

  it('refuses a cursor that points outside the column or past the rows wanted', async () => {
    const { file, profile } = await openArchive();
    const first = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 2,
      projection: ['event_id'],
    });
    const seed = first.nextColumns[0];
    if (!seed) throw new Error('expected a cursor');
    const group = file.metadata.row_groups[0];
    const column = group?.columns.find(
      (item) => item.meta_data?.path_in_schema.join('.') === 'event_id'
    );
    const end =
      Number(column?.meta_data?.data_page_offset) +
      Number(column?.meta_data?.total_compressed_size);
    const bad: FlatColumnCursor[] = [
      { ...seed, byteOffset: seed.byteOffset - 1 },
      { ...seed, byteOffset: end },
      { ...seed, byteOffset: end + 10 },
      { ...seed, byteOffset: seed.byteOffset + 0.5 },
      { ...seed, firstRow: -1 },
      { ...seed, firstRow: 3 },
      { ...seed, firstRow: 0.5 },
    ];
    for (const cursor of bad) {
      await expect(
        readFlatFileWindow({
          file,
          profile,
          rowStart: 2,
          rowEnd: 4,
          projection: ['event_id'],
          columns: [cursor],
        })
      ).rejects.toThrow('Invalid flat column cursor');
    }
    await expect(
      readFlatFileWindow({
        file,
        profile,
        rowStart: 2,
        rowEnd: 4,
        projection: ['event_id'],
        columns: [seed],
      })
    ).resolves.toBeDefined();
    // A seed that claims the page starts at row 2 makes the page overrun the row group.
    await expect(
      readFlatFileWindow({
        file,
        profile,
        rowStart: 2,
        rowEnd: 4,
        projection: ['event_id'],
        columns: [{ ...seed, firstRow: 2 }],
      })
    ).rejects.toThrow('Invalid flat data page row count');
    await expect(
      readFlatFileWindow({
        file,
        profile,
        rowStart: 2,
        rowEnd: 4,
        projection: ['event_id'],
        columns: [{ ...seed, groupIndex: 5, byteOffset: 0, firstRow: 99 }],
      })
    ).resolves.toBeDefined();
  });
});

describe('selected rows', () => {
  const probe = (value: unknown): string =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);

  it('selects the rows whose field matches, in order', async () => {
    const { file, profile } = await openArchive();
    const seen: string[] = [];
    const result = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 8,
      select: {
        field: 'tenant_key',
        matches: (value) => {
          seen.push(probe(value));
          return probe(value) === 'tenant-b';
        },
        maxMatches: 10,
      },
    });
    expect(result.rows.map((row) => row.position)).toEqual([4n, 5n, 6n, 7n]);
    expect(result.rows.every((row) => Object.keys(row.values).length === 0)).toBe(true);
    expect(result.nextRow).toBe(8);
    expect(new Set(seen)).toEqual(new Set(['tenant-a', 'tenant-b']));
  });

  it('selects on the event id and the subject id', async () => {
    const { file, profile } = await openArchive();
    const byId = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 8,
      select: { field: 'event_id', matches: (v) => probe(v) === 'event-5', maxMatches: 10 },
    });
    expect(byId.rows.map((row) => row.position)).toEqual([5n]);
    const bySubject = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 8,
      select: { field: 'subject_id', matches: (v) => probe(v) === 'subject-odd', maxMatches: 10 },
    });
    expect(bySubject.rows.map((row) => row.position)).toEqual([1n, 3n, 5n, 7n]);
  });

  it('stops at the match limit and says where to continue', async () => {
    const { file, profile } = await openArchive();
    const result = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 8,
      select: { field: 'subject_id', matches: (v) => probe(v) === 'subject-odd', maxMatches: 2 },
    });
    expect(result.rows.map((row) => row.position)).toEqual([1n, 3n]);
    expect(result.nextRow).toBe(4);
    const one = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 8,
      select: { field: 'subject_id', matches: (v) => probe(v) === 'subject-odd', maxMatches: 1 },
    });
    expect(one.rows.map((row) => row.position)).toEqual([1n]);
    expect(one.nextRow).toBe(2);
  });

  it('matches nothing when nothing matches', async () => {
    const { file, profile } = await openArchive();
    const result = await readFlatFileWindow({
      file,
      profile,
      rowStart: 0,
      rowEnd: 8,
      select: { field: 'event_id', matches: () => false, maxMatches: 3 },
    });
    expect(result.rows).toEqual([]);
    expect(result.nextRow).toBe(8);
  });
});

describe('provider timestamp column', () => {
  const read = async (file: OpenedFile, profile: Profile) =>
    readFlatFileWindow({ file, profile, rowStart: 0, rowEnd: 1, projection: ['__ingest_ts'] });
  const providerOf = (file: OpenedFile) => {
    const element = file.metadata.schema.find((candidate) => candidate.name === '__ingest_ts');
    if (!element) throw new Error('expected the provider column');
    return element;
  };

  it('reads it as microseconds', async () => {
    const { file, profile } = await openArchive({ pipeline: true });
    expect((await read(file, profile)).rows[0]?.values.__ingest_ts).toBe(1793000001000000n);
  });

  it('converts the unit of the annotation to microseconds', async () => {
    const { file, profile } = await openArchive({ pipeline: true });
    const as = async (unit: 'MILLIS' | 'MICROS' | 'NANOS') => {
      const copy = copyOf(file, (target) => {
        providerOf(target).logical_type = { type: 'TIMESTAMP', isAdjustedToUTC: true, unit };
      });
      return (await read(copy, profile)).rows[0]?.values.__ingest_ts;
    };
    expect(await as('MICROS')).toBe(1793000001000000n);
    expect(await as('MILLIS')).toBe(1793000001000000n * 1000n);
    expect(await as('NANOS')).toBe(1793000001000000n / 1000n);
  });

  it('falls back to the converted type, and refuses a column with no annotation', async () => {
    const { file, profile } = await openArchive({ pipeline: true });
    const converted = async (type: 'TIMESTAMP_MILLIS' | 'TIMESTAMP_MICROS' | undefined) =>
      read(
        copyOf(file, (target) => {
          const element = providerOf(target);
          element.logical_type = undefined;
          element.converted_type = type;
        }),
        profile
      );
    expect((await converted('TIMESTAMP_MICROS')).rows[0]?.values.__ingest_ts).toBe(
      1793000001000000n
    );
    expect((await converted('TIMESTAMP_MILLIS')).rows[0]?.values.__ingest_ts).toBe(
      1793000001000000n * 1000n
    );
    await expect(converted(undefined)).rejects.toThrow('Provider timestamp annotation is missing');
  });

  it('is simply absent when the file has no such column', async () => {
    const { file, profile } = await openArchive({ pipeline: true });
    const copy = copyOf(file, (target) => {
      const index = target.metadata.schema.findIndex((element) => element.name === '__ingest_ts');
      target.metadata.schema.splice(index, 1);
      target.metadata.schema[0].num_children = Number(target.metadata.schema[0].num_children) - 1;
      for (const group of target.metadata.row_groups) {
        const column = group.columns.findIndex(
          (item) => item.meta_data?.path_in_schema.join('.') === '__ingest_ts'
        );
        if (column >= 0) group.columns.splice(column, 1);
      }
    });
    const result = await read(copy, profile);
    expect(result.rows[0]?.values).toEqual({ __ingest_ts: null });
  });
});

describe('physical columns', () => {
  it('refuses a column that is repeated or has no repetition type', async () => {
    const { file, profile } = await openArchive();
    for (const repetition of ['REPEATED', undefined] as const) {
      const copy = copyOf(file, (target) => {
        const element = target.metadata.schema.find(
          (e) => e.field_id === profile.fieldIds.event_id
        );
        if (element) element.repetition_type = repetition;
      });
      await expect(
        readFlatFileWindow({
          file: copy,
          profile,
          rowStart: 0,
          rowEnd: 2,
          projection: ['event_id'],
        })
      ).rejects.toThrow('Unsupported flat physical column type');
    }
    for (const type of ['INT32', 'BYTE_ARRAY', 'INT64'] as const) {
      const copy = copyOf(file, (target) => {
        const element = target.metadata.schema.find(
          (e) => e.field_id === profile.fieldIds.event_at
        );
        if (element) element.type = type;
      });
      const outcome = readFlatFileWindow({
        file: copy,
        profile,
        rowStart: 0,
        rowEnd: 2,
        projection: ['event_at'],
      });
      if (type === 'INT64') await expect(outcome).resolves.toBeDefined();
      else await expect(outcome).rejects.toThrow('Unsupported flat physical column type');
    }
    const int = copyOf(file, (target) => {
      const element = target.metadata.schema.find(
        (e) => e.field_id === profile.fieldIds.schema_version
      );
      if (element) element.type = 'INT64';
    });
    await expect(
      readFlatFileWindow({
        file: int,
        profile,
        rowStart: 0,
        rowEnd: 2,
        projection: ['schema_version'],
      })
    ).rejects.toThrow('Unsupported flat physical column type');
  });

  it('refuses a column outside the data area of the file', async () => {
    const { file, profile } = await openArchive();
    const short = { ...file, footerStart: 100 };
    await expect(
      readFlatFileWindow({ file: short, profile, rowStart: 0, rowEnd: 2, projection: ['event_id'] })
    ).rejects.toThrow('Invalid Parquet column range');
    const start = copyOf(file, (target) => {
      for (const group of target.metadata.row_groups) {
        for (const column of group.columns) {
          if (column.meta_data) {
            column.meta_data.data_page_offset = 2n;
            column.meta_data.dictionary_page_offset = undefined;
          }
        }
      }
    });
    await expect(
      readFlatFileWindow({ file: start, profile, rowStart: 0, rowEnd: 2, projection: ['event_id'] })
    ).rejects.toThrow();
  });
});
