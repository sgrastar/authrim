import type { BackupSchemaForeignKey } from '../sqlite-schema-types';

/** Group physical composite keys without depending on ES2024 Map.groupBy type declarations. */
export function foreignKeyGroups(
  keys: readonly BackupSchemaForeignKey[]
): BackupSchemaForeignKey[][] {
  const groups = new Map<number, BackupSchemaForeignKey[]>();
  for (const key of keys) {
    const group = groups.get(key.id);
    if (group) group.push(key);
    else groups.set(key.id, [key]);
  }
  return [...groups.values()];
}
