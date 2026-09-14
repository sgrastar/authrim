import { fileURLToPath } from 'node:url';
import { inventoryBackupBindings } from './binding-inventory.js';
import { inventoryBackupSchemas } from './schema-inventory.js';
import { assessSnapshotTable } from './snapshot-applicability.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const inventory = inventoryBackupSchemas(repositoryRoot);
process.stdout.write(
  `${JSON.stringify(
    {
      ...inventory,
      storageBindings: inventoryBackupBindings(repositoryRoot),
      snapshotStructureChecks: inventory.inspectedStreams.map((stream) => ({
        stream: stream.id,
        tables: stream.tables.map((table) => ({
          table: table.name,
          concerns: assessSnapshotTable(table).concerns,
        })),
      })),
    },
    null,
    2
  )}\n`
);
