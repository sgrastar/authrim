import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from '../test-sqlite';

const groupMigration = readFileSync(
  new URL('../../../../../migrations/core/d1/007_service_dynamic_groups.sql', import.meta.url),
  'utf8'
);

/** Real boundary rows and revision triggers; unrelated fixture SQL keeps its own behavior. */
export function installGroupBoundaryFixture(binding: D1Database): SQLiteDatabase {
  const database = new DatabaseSync(':memory:');
  const inputs = groupMigration.match(
    /CREATE TABLE IF NOT EXISTS service_group_inputs \([\s\S]*?\n\);/u
  )?.[0];
  const boundaryStart = groupMigration.indexOf('CREATE TABLE service_group_write_boundaries (');
  if (!inputs || boundaryStart < 0) throw new Error('group_boundary_fixture_schema_missing');
  database.exec(inputs);
  database.exec(groupMigration.slice(boundaryStart));
  const prepare = vi.spyOn(binding, 'prepare');
  const prepareOriginal = prepare.getMockImplementation();
  if (!prepareOriginal) throw new Error('core_prepare_fixture_missing');
  prepare.mockImplementation((sql) => {
    if (!/\bservice_group_(?:write_boundaries|inputs)\b/u.test(sql))
      return prepareOriginal.call(binding, sql);
    const statement = (params: unknown[] = []): D1PreparedStatement => {
      const values = params.map((value): SQLInputValue => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        )
          return value;
        throw new Error('group_boundary_fixture_parameter_invalid');
      });
      return {
        bind: (...next: unknown[]) => statement(next),
        first: async () => database.prepare(sql).get(...values) ?? null,
        all: async () => ({ success: true, results: database.prepare(sql).all(...values) }),
        run: async () => {
          const totalChanges = () => {
            const row = database.prepare('SELECT total_changes() AS n').get() as { n: unknown };
            if (typeof row.n !== 'number' || !Number.isSafeInteger(row.n) || row.n < 0)
              throw new Error('group_boundary_fixture_changes_invalid');
            return row.n;
          };
          const before = totalChanges();
          database.prepare(sql).run(...values);
          return { success: true, results: [], meta: { changes: totalChanges() - before } };
        },
      } as unknown as D1PreparedStatement;
    };
    return statement();
  });
  return database;
}
