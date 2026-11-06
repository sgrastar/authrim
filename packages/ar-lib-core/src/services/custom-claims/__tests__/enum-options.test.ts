import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { enumOptionLabel, enumOptionsOf, normalizeEnumRules, enumValuesOf } from '../enum-options';
import { findHeldNonPiiValuesOutside } from '../storage-admin';

describe('normalizeEnumRules', () => {
  it('keeps bare values, trimmed', () => {
    expect(normalizeEnumRules({ enum_values: [' a', 'b '] })).toEqual({
      ok: true,
      rules: { enum_values: ['a', 'b'] },
    });
  });

  it('derives the values from the options and drops empty labels', () => {
    expect(
      normalizeEnumRules({
        enum_options: [
          { value: 'jp', label: 'Japan', labels: { ja: ' 日本 ', de: '' } },
          { value: 'us', label: ' ' },
        ],
      })
    ).toEqual({
      ok: true,
      rules: {
        enum_values: ['jp', 'us'],
        enum_options: [{ value: 'jp', label: 'Japan', labels: { ja: '日本' } }, { value: 'us' }],
      },
    });
  });

  it.each([
    [{}, 'non-empty'],
    [{ enum_values: [] }, 'non-empty'],
    [{ enum_values: ['a', 'a'] }, 'twice'],
    [{ enum_values: ['x'.repeat(129)] }, '128'],
    [{ enum_options: [{ value: 'a', note: 'x' }] }, 'Unknown enum option key'],
    [{ enum_options: [{ value: 'a', labels: { klingon: 'A' } }] }, 'unknown language'],
    [{ enum_options: [{ value: 'a', label: 'x'.repeat(101) }] }, '100'],
    [{ enum_values: ['b'], enum_options: [{ value: 'a' }] }, 'same order'],
    [{ enum_values: ['a'], extra: true }, 'Unknown enum validation key'],
  ])('refuses %j', (rules, message) => {
    const result = normalizeEnumRules(rules);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe('labels and removed values', () => {
  const rules = {
    enum_values: ['jp', 'us'],
    enum_options: [{ value: 'jp', label: 'Japan', labels: { ja: '日本' } }, { value: 'us' }],
  };

  it('shows the language label, else the default label, else the value', () => {
    const [jp, us] = enumOptionsOf(rules);
    expect(enumOptionLabel(jp, 'ja')).toBe('日本');
    expect(enumOptionLabel(jp, 'fr')).toBe('Japan');
    expect(enumOptionLabel(us, 'ja')).toBe('us');
  });

  it('reads rules without options as options without labels', () => {
    expect(enumOptionsOf({ enum_values: ['a'] })).toEqual([{ value: 'a' }]);
  });

  it('lists the values rules allow (none: any value)', () => {
    expect(enumValuesOf(rules)).toEqual(['jp', 'us']);
    expect(enumValuesOf(null)).toEqual([]);
  });
});

describe('findHeldNonPiiValuesOutside', () => {
  function store(rows: [string, string, string][]): DatabaseAdapter {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE user_custom_fields (tenant_id TEXT, user_id TEXT, field_name TEXT, field_value TEXT, field_type TEXT)'
    );
    const insert = db.prepare("INSERT INTO user_custom_fields VALUES ('t1', ?, ?, ?, 'enum')");
    for (const row of rows) insert.run(...row);
    const all = (sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as string[]));
    return {
      query: async (sql: string, params?: unknown[]) => all(sql, params),
      queryOne: async (sql: string, params?: unknown[]) => all(sql, params)[0] ?? null,
      execute: async () => ({ success: true, rowsAffected: 0 }),
      batch: async () => [],
      transaction: async () => {
        throw new Error('not used');
      },
      isHealthy: async () => ({ healthy: true, latencyMs: 0 }),
      getType: () => 'sqlite',
      close: async () => undefined,
    } as unknown as DatabaseAdapter;
  }

  it('finds single values outside the allowed ones, by user', async () => {
    const db = store([
      ['u1', 'gender', 'other'],
      ['u2', 'gender', 'other'],
      ['u3', 'gender', 'female'],
      ['u4', 'country', 'other'],
    ]);
    const held = await findHeldNonPiiValuesOutside(
      db,
      't1',
      'gender',
      ['female', 'male'],
      'single'
    );
    expect(held.complete).toBe(true);
    expect(Object.fromEntries(held.counts)).toEqual({ other: 2 });
  });

  it('reads every page of a large attribute', async () => {
    const rows: [string, string, string][] = Array.from({ length: 1203 }, (_, index) => [
      `u${index}`,
      'code',
      `v${String(index).padStart(5, '0')}`,
    ]);
    const db = store(rows);
    const allowed = rows.slice(0, 1202).map(([, , value]) => value);
    const held = await findHeldNonPiiValuesOutside(db, 't1', 'code', allowed, 'single');
    // The one value not allowed is on the third page.
    expect(Object.fromEntries(held.counts)).toEqual({ v01202: 1 });
  });

  it('counts exactly the values asked for, however many others there are', async () => {
    const rows: [string, string, string][] = [
      ...Array.from({ length: 25 }, (_, index): [string, string, string] => [
        `u${index}`,
        'code',
        `a${String(index).padStart(2, '0')}`,
      ]),
      ['u90', 'code', 'z'],
      ['u91', 'code', 'z'],
    ];
    const db = store(rows);
    // With the default limit, "z" (sorted last) is not among the 20 reported...
    const first = await findHeldNonPiiValuesOutside(db, 't1', 'code', [], 'single');
    expect(first.counts.size).toBe(20);
    expect(first.counts.has('z')).toBe(false);
    // ...and asked for by name, it is counted in full.
    const only = await findHeldNonPiiValuesOutside(db, 't1', 'code', [], 'single', {
      only: ['z'],
    });
    expect(Object.fromEntries(only.counts)).toEqual({ z: 2 });
  });

  it('looks inside the arrays of a multi-value attribute', async () => {
    const db = store([
      ['u1', 'tags', JSON.stringify(['a_b', 'c'])],
      ['u2', 'tags', JSON.stringify(['c'])],
      ['u3', 'tags', JSON.stringify(['100%', 'a"q'])],
      ['u4', 'tags', JSON.stringify(['c', 'z'])],
    ]);
    const held = await findHeldNonPiiValuesOutside(db, 't1', 'tags', ['c', 'a_b'], 'multi');
    expect(Object.fromEntries(held.counts)).toEqual({ '100%': 1, 'a"q': 1, z: 1 });
  });

  it('does not aggregate more single-value rows than its budget reads', async () => {
    // 501 users, one value: the aggregate would be one row, but it would read all 501.
    const rows: [string, string, string][] = Array.from({ length: 501 }, (_, index) => [
      `u${index}`,
      'plan',
      'gold',
    ]);
    const db = store(rows);
    const bounded = await findHeldNonPiiValuesOutside(db, 't1', 'plan', ['gold'], 'single', {
      maxPages: 1,
    });
    expect(bounded.complete).toBe(false);
    const within = await findHeldNonPiiValuesOutside(db, 't1', 'plan', ['gold'], 'single', {
      maxPages: 2,
    });
    expect(within.complete).toBe(true);
  });

  it('stops after its page budget and says the answer is incomplete', async () => {
    const rows: [string, string, string][] = Array.from({ length: 1200 }, (_, index) => [
      `u${String(index).padStart(5, '0')}`,
      'tags',
      JSON.stringify(['c']),
    ]);
    const db = store(rows);
    const held = await findHeldNonPiiValuesOutside(db, 't1', 'tags', ['c'], 'multi', {
      maxPages: 2,
    });
    expect(held.complete).toBe(false);
    const all = await findHeldNonPiiValuesOutside(db, 't1', 'tags', ['c'], 'multi');
    expect(all.complete).toBe(true);
  });
});
