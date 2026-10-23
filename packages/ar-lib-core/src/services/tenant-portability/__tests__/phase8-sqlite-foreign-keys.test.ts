import { describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../../repositories/__tests__/sqlite-core-schema';
import { PHASE8_SQLITE_FOREIGN_KEY_RULES } from '../phase8-sqlite-foreign-keys';

describe('Phase 8 SQL foreign key rules', () => {
  it('names only foreign keys the Core schema has', () => {
    // A rule for a key a migration dropped would make a restore demand a row the target need
    // not have (an assignment's role, or a users_core row nothing writes).
    const { db } = sqliteAdapter();
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const keys = new Set<string>();
    for (const { name } of tables) {
      const columns = new Map<number, { table: string; from: string[] }>();
      for (const row of db
        .prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq')
        .all(name) as Array<{ id: number; table: string; from: string }>) {
        const key = columns.get(row.id) ?? { table: row.table, from: [] };
        key.from.push(row.from);
        columns.set(row.id, key);
      }
      for (const { table, from } of columns.values()) {
        keys.add(`core.${name}(${from.join(',')})->core.${table}`);
      }
    }

    const missing = PHASE8_SQLITE_FOREIGN_KEY_RULES.filter(({ from }) => from.startsWith('core.'))
      .map(({ from, columns, to }) => `${from}(${columns.join(',')})->${to}`)
      .filter((rule) => !keys.has(rule));
    expect(missing).toEqual([]);
  });
});
