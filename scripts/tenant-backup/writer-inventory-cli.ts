import { fileURLToPath } from 'node:url';
import { inventoryBackupWriters } from './writer-inventory.js';

process.stdout.write(
  `${JSON.stringify(inventoryBackupWriters(fileURLToPath(new URL('../../', import.meta.url))), null, 2)}\n`
);
