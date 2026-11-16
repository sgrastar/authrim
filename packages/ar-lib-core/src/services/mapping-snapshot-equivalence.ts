import { z } from 'zod';

const portableMappingRow = z.record(z.string(), z.tuple([z.string(), z.string().nullable()]));

const migrationEquivalence = z.object({
  graphMigration023: z.object({
    previousSnapshotHash: z.string().min(1),
    snapshotHash: z.string().min(1),
  }),
});

/** Only the exact snapshot rewritten by migration 023 can recognize its previous hash. */
export function equivalentMappingSnapshotHashes(
  metadata: string | null | undefined,
  snapshotHash: string
): string[] {
  try {
    const parsed = migrationEquivalence.safeParse(JSON.parse(metadata ?? '{}'));
    if (!parsed.success || parsed.data.graphMigration023.snapshotHash !== snapshotHash) return [];
    return [parsed.data.graphMigration023.previousSnapshotHash];
  } catch {
    return [];
  }
}

export function runtimeMappingSnapshotMatches(
  binding: {
    mappingSnapshotHash: string;
    equivalentMappingSnapshotHashes?: string[];
    mappingSnapshotPinTrusted?: boolean;
  },
  pinnedHash: string
): boolean {
  return (
    binding.mappingSnapshotPinTrusted !== false &&
    (binding.mappingSnapshotHash === pinnedHash ||
      binding.equivalentMappingSnapshotHashes?.includes(pinnedHash) === true)
  );
}

/** Migration trust is local to the deployment; an imported bundle cannot grant equivalence. */
export function restoreMappingSnapshotMetadata(metadata: string | null): string {
  const parsed: unknown = JSON.parse(metadata ?? '{}');
  const object = z.record(z.string(), z.unknown()).parse(parsed);
  delete object.graphMigration023;
  // Neither a supplied hash nor a supplied trust marker proves compilation of restored rows.
  object.snapshotPinState = 'requires_recompile';
  return JSON.stringify(object);
}

/** Apply the same exclusion before D1 restore writes and verification. */
export function restoredMappingSnapshotRow(rowJson: string): string {
  const row = portableMappingRow.parse(JSON.parse(rowJson));
  const metadata = row.metadata_json;
  if (metadata && metadata[0] !== 'text' && metadata[0] !== 'null')
    throw new Error('backup_mapping_snapshot_metadata_invalid');
  row.metadata_json = ['text', restoreMappingSnapshotMetadata(metadata?.[1] ?? null)];
  return JSON.stringify(row);
}

/** Installed restore callback; source metadata never becomes local migration authority. */
export async function restoreMappingSnapshotRow(
  _context: unknown,
  rowJson: string
): Promise<string> {
  return restoredMappingSnapshotRow(rowJson);
}

/** Always replace uploaded provenance with the destination operation's stable restore ID. */
export function restoredMappingVersionRow(rowJson: string, restoreId: string): string {
  const row = portableMappingRow.parse(JSON.parse(rowJson));
  row.restore_id = ['text', z.string().min(1).max(256).parse(restoreId)];
  return JSON.stringify(row);
}

/** Write and verification retries use the same destination-owned operation ID. */
export async function restoreMappingVersionRow(
  context: { operation: { id: string } },
  rowJson: string
): Promise<string> {
  return restoredMappingVersionRow(rowJson, context.operation.id);
}
