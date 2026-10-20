import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { planSqliteTenantDatasets } from '../sqlite-dataset-plan';
import { sqliteSnapshotReadStatements } from '../sqlite-dataset-source';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
// D1 rejects a statement longer than 100,000 bytes. Wide tables (oauth_clients) and long composite
// keys (logging_delivery_event_aggregates) are the ones closest to it.
const D1_STATEMENT_BYTES = 100_000;

it('keeps every snapshot read statement of every installed table under the D1 length limit', () => {
  const inventory = inventoryBackupSchemas(root);
  const selection = {
    settings: true,
    users: true,
    admin: true,
    artifacts: true,
    logs: { audit: true, other: true, sensitive: true, period: 'all' as const },
  };
  const lengths: Array<[string, number]> = [];
  for (const stream of inventory.inspectedStreams) {
    const family = stream.id.replace(/-d1$/, '');
    // plugin-runner tables are not classified for tenant backup.
    if (family === 'plugin-runner') continue;
    const plan = planSqliteTenantDatasets(family as 'core', stream.tables, selection);
    for (const schema of plan.captureSchemas) {
      const partitions = schema.rowPartition ? schema.rowPartition.values : undefined;
      for (const [name, sql] of Object.entries(sqliteSnapshotReadStatements(schema, partitions)))
        lengths.push([
          `${stream.id}.${schema.table}.${name}`,
          new TextEncoder().encode(sql).length,
        ]);
    }
  }
  expect(lengths.length).toBeGreaterThan(500);
  expect(lengths.filter(([, bytes]) => bytes >= D1_STATEMENT_BYTES)).toEqual([]);
  // Leave room for schema growth: the longest statement must not creep up to the limit unnoticed.
  expect(Math.max(...lengths.map(([, bytes]) => bytes))).toBeLessThan(D1_STATEMENT_BYTES * 0.8);
});
