import { describe, expect, it, vi } from 'vitest';
import {
  parsePortableRow,
  readVerifiedRows,
  rowInteger,
  rowNullableText,
  rowOptionalInteger,
  rowSqliteValue,
  rowText,
} from './verified-rows';
import type { VerifiedTenantBackupV2 } from './backup-reader';

const INVALID = 'aws_backup_dataset_invalid';

function backupOf(rowsJson: string[], declaredRows = rowsJson.length, cursors?: string[]) {
  const readNextRow = vi.fn(async (cursor: string | null) => {
    const index = cursor === null ? 0 : Number(cursor.replace('c', ''));
    if (index >= rowsJson.length) return null;
    return { rowJson: rowsJson[index], nextCursor: cursors ? cursors[index] : `c${index + 1}` };
  });
  const dataset = vi.fn((id: string) => ({ id, rows: declaredRows, readNextRow }));
  return { backup: { dataset } as unknown as VerifiedTenantBackupV2, dataset, readNextRow };
}

const text = (v: string) => ['text', v];

describe('parsePortableRow', () => {
  it('accepts a valid row and returns the decoded object', () => {
    const row = parsePortableRow(
      JSON.stringify({
        a: ['null', null],
        b: ['text', 'x'],
        c: ['integer', '1'],
        d: ['real', '1.5'],
        e: ['blob', 'AA'],
      })
    );
    expect(row.b).toEqual(['text', 'x']);
  });
  it.each([
    ['not json', '{'],
    ['null', 'null'],
    ['string', '"x"'],
    ['array', '[]'],
    ['uppercase column', JSON.stringify({ A: text('x') })],
    ['digit-leading column', JSON.stringify({ '1a': text('x') })],
    ['too long column', JSON.stringify({ ['a' + 'b'.repeat(128)]: text('x') })],
    ['non-array cell', JSON.stringify({ a: 'x' })],
    ['cell length 1', JSON.stringify({ a: ['text'] })],
    ['cell length 3', JSON.stringify({ a: ['text', 'x', 'y'] })],
    ['unknown type', JSON.stringify({ a: ['bogus', 'x'] })],
    ['null with value', JSON.stringify({ a: ['null', 'x'] })],
    ['text with non-string', JSON.stringify({ a: ['text', 1] })],
    ['text with null', JSON.stringify({ a: ['text', null] })],
  ])('rejects %s', (_n, json) => {
    expect(() => parsePortableRow(json)).toThrow(new Error(INVALID));
  });
  it('accepts 128-char column name', () => {
    expect(() =>
      parsePortableRow(JSON.stringify({ ['a' + 'b'.repeat(127)]: text('x') }))
    ).not.toThrow();
  });
  it('accepts an empty object', () => {
    expect(parsePortableRow('{}')).toEqual({});
  });
});

describe('readVerifiedRows', () => {
  it('reads rows in order and passes cursors', async () => {
    const { backup, dataset, readNextRow } = backupOf([
      JSON.stringify({ a: text('1') }),
      JSON.stringify({ a: text('2') }),
    ]);
    const rows = await readVerifiedRows(backup, 'ds');
    expect(dataset).toHaveBeenCalledWith('ds');
    expect(rows.map((r) => r.a[1])).toEqual(['1', '2']);
    expect(readNextRow.mock.calls.map((c) => c[0])).toEqual([null, 'c1', 'c2']);
  });
  it('rejects too many declared rows but accepts exactly the max', async () => {
    const over = backupOf([], 100_001);
    await expect(readVerifiedRows(over.backup, 'ds')).rejects.toThrow(INVALID);
    expect(over.readNextRow).not.toHaveBeenCalled();
  });
  it('accepts exactly the maximum number of rows', async () => {
    const readNextRow = vi.fn(async (cursor: string | null) => {
      const i = cursor === null ? 0 : Number(cursor);
      return i >= 100_000 ? null : { rowJson: '{}', nextCursor: String(i + 1) };
    });
    const backup = {
      dataset: () => ({ rows: 100_000, readNextRow }),
    } as unknown as VerifiedTenantBackupV2;
    await expect(readVerifiedRows(backup, 'ds')).resolves.toHaveLength(100_000);
  });
  it('rejects empty cursor', async () => {
    const { backup } = backupOf([JSON.stringify({ a: text('1') })], 1, ['']);
    await expect(readVerifiedRows(backup, 'ds')).rejects.toThrow(INVALID);
  });
  it('rejects repeated cursor', async () => {
    const { backup } = backupOf(
      [JSON.stringify({ a: text('1') }), JSON.stringify({ a: text('2') })],
      2,
      ['c1', 'c1']
    );
    await expect(readVerifiedRows(backup, 'ds')).rejects.toThrow(INVALID);
  });
  it('rejects when read count differs from declared', async () => {
    const { backup } = backupOf([JSON.stringify({ a: text('1') })], 2);
    await expect(readVerifiedRows(backup, 'ds')).rejects.toThrow(INVALID);
    const more = backupOf([JSON.stringify({ a: text('1') }), JSON.stringify({ a: text('2') })], 1);
    await expect(readVerifiedRows(more.backup, 'ds')).rejects.toThrow(INVALID);
  });
  it('rejects at the row cap while reading', async () => {
    const readNextRow = vi.fn(async (cursor: string | null) => {
      const i = cursor === null ? 0 : Number(cursor);
      return { rowJson: '{}', nextCursor: String(i + 1) };
    });
    const backup = {
      dataset: () => ({ rows: 100_000, readNextRow }),
    } as unknown as VerifiedTenantBackupV2;
    await expect(readVerifiedRows(backup, 'ds')).rejects.toThrow(INVALID);
    expect(readNextRow).toHaveBeenCalledTimes(100_001);
  });
  it('propagates invalid row json', async () => {
    const { backup } = backupOf(['nope']);
    await expect(readVerifiedRows(backup, 'ds')).rejects.toThrow(INVALID);
  });
});

describe('row accessors', () => {
  const row = parsePortableRow(
    JSON.stringify({
      t: ['text', 'hello'],
      n: ['null', null],
      i: ['integer', '42'],
      neg: ['integer', '-5'],
      lead: ['integer', '01'],
      big: ['integer', '9007199254740993'],
      f: ['real', '1.5'],
      nan: ['real', 'abc'],
      inf: ['integer', 'abc'],
      b: ['blob', 'AA'],
    })
  );
  it('rowText', () => {
    expect(rowText(row, 't')).toBe('hello');
    expect(() => rowText(row, 'n')).toThrow(INVALID);
    expect(() => rowText(row, 'i')).toThrow(INVALID);
    expect(() => rowText(row, 'missing')).toThrow(INVALID);
  });
  it('rowNullableText', () => {
    expect(rowNullableText(row, 'n')).toBeNull();
    expect(rowNullableText(row, 'missing')).toBeNull();
    expect(rowNullableText(row, 't')).toBe('hello');
    expect(() => rowNullableText(row, 'i')).toThrow(INVALID);
  });
  it('rowInteger', () => {
    expect(rowInteger(row, 'i')).toBe(42);
    expect(() => rowInteger(row, 'neg')).toThrow(INVALID);
    expect(rowInteger(row, 'neg', -5)).toBe(-5);
    expect(() => rowInteger(row, 'neg', -4)).toThrow(INVALID);
    expect(rowInteger(row, 'i', 42)).toBe(42);
    expect(() => rowInteger(row, 'i', 43)).toThrow(INVALID);
    expect(() => rowInteger(row, 'lead')).toThrow(INVALID);
    expect(() => rowInteger(row, 'big')).toThrow(INVALID);
    expect(() => rowInteger(row, 'inf')).toThrow(INVALID);
    expect(() => rowInteger(row, 't')).toThrow(INVALID);
    expect(() => rowInteger(row, 'missing')).toThrow(INVALID);
    expect(() => rowInteger(row, 'f')).toThrow(INVALID);
  });
  it('rowInteger accepts zero and anchors regex', () => {
    const r = parsePortableRow(
      JSON.stringify({
        z: ['integer', '0'],
        x: ['integer', '1x'],
        y: ['integer', 'x1'],
        m: ['integer', '-0'],
      })
    );
    expect(rowInteger(r, 'z')).toBe(0);
    expect(() => rowInteger(r, 'x')).toThrow(INVALID);
    expect(() => rowInteger(r, 'y')).toThrow(INVALID);
  });
  it('rowOptionalInteger', () => {
    expect(rowOptionalInteger(row, 'n')).toBeNull();
    expect(rowOptionalInteger(row, 'missing')).toBeNull();
    expect(rowOptionalInteger(row, 'i')).toBe(42);
    expect(() => rowOptionalInteger(row, 'neg')).toThrow(INVALID);
  });
  it('rowSqliteValue', () => {
    expect(rowSqliteValue(row, 'n')).toBeNull();
    expect(rowSqliteValue(row, 't')).toBe('hello');
    expect(rowSqliteValue(row, 'i')).toBe(42);
    expect(rowSqliteValue(row, 'neg')).toBe(-5);
    expect(rowSqliteValue(row, 'f')).toBe(1.5);
    expect(() => rowSqliteValue(row, 'nan')).toThrow(INVALID);
    expect(() => rowSqliteValue(row, 'inf')).toThrow(INVALID);
    expect(() => rowSqliteValue(row, 'big')).toThrow(INVALID);
    expect(() => rowSqliteValue(row, 'b')).toThrow(INVALID);
    expect(() => rowSqliteValue(row, 'missing')).toThrow(INVALID);
  });
  it('rowSqliteValue accepts unsafe real values', () => {
    const r = parsePortableRow(JSON.stringify({ r: ['real', '9007199254740993'] }));
    expect(rowSqliteValue(r, 'r')).toBe(9007199254740992);
  });
});
