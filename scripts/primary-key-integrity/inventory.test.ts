import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSchema } from './schema-inventory.js';
import { classifyPrimaryKey } from './inventory.js';

void test('distinguishes SQLite key nullability from PRAGMA metadata alone', () => {
  const cases = [
    ['id TEXT PRIMARY KEY', '', 'nullable_primary_key'],
    ['id TEXT NOT NULL PRIMARY KEY', '', 'explicit_not_null'],
    ['id INTEGER PRIMARY KEY', '', 'integer_rowid_alias'],
    ['id INTEGER PRIMARY KEY DESC', '', 'nullable_primary_key'],
    ['id INT PRIMARY KEY', '', 'nullable_primary_key'],
    ['id TEXT PRIMARY KEY', 'STRICT', 'strict_primary_key'],
    ['id TEXT PRIMARY KEY', 'WITHOUT ROWID', 'without_rowid_primary_key'],
  ];
  for (const [definition, flags, expected] of cases) {
    const result = classifyPrimaryKey(
      inspectSchema([`CREATE TABLE items (${definition}) ${flags}`]).tables[0]
    );
    assert.equal(result.columns[0].guarantee, expected, `${definition} ${flags}`);
  }
});

void test('checks every component of composite primary keys and does not invent absent keys', () => {
  const composite = classifyPrimaryKey(
    inspectSchema([
      'CREATE TABLE items (tenant_id TEXT NOT NULL, id TEXT, PRIMARY KEY (tenant_id,id))',
    ]).tables[0]
  );
  assert.deepEqual(
    composite.columns.map((column) => [column.name, column.guarantee]),
    [
      ['tenant_id', 'explicit_not_null'],
      ['id', 'nullable_primary_key'],
    ]
  );
  assert.equal(
    classifyPrimaryKey(inspectSchema(['CREATE TABLE items (id TEXT)']).tables[0]).status,
    'no_primary_key'
  );
});

void test('fresh installation across every D1 stream has no nullable primary keys', async () => {
  const { inventorySchemas } = await import('./schema-inventory.js');
  const { fileURLToPath } = await import('node:url');
  const inventory = inventorySchemas(fileURLToPath(new URL('../../', import.meta.url)));
  for (const stream of inventory.inspectedStreams) {
    for (const table of stream.tables) {
      assert.equal(
        classifyPrimaryKey(table).columns.some(
          (column) => column.guarantee === 'nullable_primary_key'
        ),
        false,
        `${stream.id}:${table.name}`
      );
    }
  }
});
