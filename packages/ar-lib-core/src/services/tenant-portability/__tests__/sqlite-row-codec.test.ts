import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { sqliteSnapshotRowInsert } from '../sqlite-row-codec';

describe('SQLite backup typed row decoder', () => {
  it('restores exact SQL types without binding large integers through JS numbers', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        'CREATE TABLE values_test (large INTEGER, bytes BLOB, nothing_value TEXT, text_value TEXT, real_value REAL)'
      );
      const insert = sqliteSnapshotRowInsert(
        'values_test',
        ['large', 'bytes', 'nothing_value', 'text_value', 'real_value'],
        JSON.stringify({
          large: ['integer', '9223372036854775807'],
          bytes: ['blob', '00FF'],
          nothing_value: ['null', null],
          text_value: ['text', "'); DROP TABLE values_test; --"],
          real_value: ['real', '1.2345678901234567'],
        })
      );
      db.prepare(insert.sql).run(...insert.params);
      expect(
        db
          .prepare(
            'SELECT CAST(large AS TEXT) AS large, hex(bytes) AS bytes, nothing_value, text_value, typeof(real_value) AS real_type FROM values_test'
          )
          .get()
      ).toEqual({
        large: '9223372036854775807',
        bytes: '00FF',
        nothing_value: null,
        text_value: "'); DROP TABLE values_test; --",
        real_type: 'real',
      });
    } finally {
      db.close();
    }
  });

  it.each([
    ['integer', '9223372036854775808'],
    ['integer', '1; DELETE'],
    ['integer', '01'],
    ['real', 'NaN'],
    ['real', '1e999'],
    ['blob', 'ABC'],
    ['blob', 'zz'],
    ['null', 'null'],
    ['text', 10],
    ['function', 'alert(1)'],
  ])('rejects invalid %s values before producing an insert', (type, value) => {
    expect(() =>
      sqliteSnapshotRowInsert('items', ['value'], JSON.stringify({ value: [type, value] }))
    ).toThrow();
  });

  it('rejects missing, extra, and inherited fields instead of applying a partial row', () => {
    for (const row of ['{}', '[]', 'null', '{"value":["text","x"],"extra":["text","y"]}']) {
      expect(() => sqliteSnapshotRowInsert('items', ['value'], row)).toThrow();
    }
    expect(() => sqliteSnapshotRowInsert('items; DROP TABLE items', ['value'], '{}')).toThrow();
  });
});
