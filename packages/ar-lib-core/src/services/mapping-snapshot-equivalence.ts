import { z } from 'zod';

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
  binding: { mappingSnapshotHash: string; equivalentMappingSnapshotHashes?: string[] },
  pinnedHash: string
): boolean {
  return (
    binding.mappingSnapshotHash === pinnedHash ||
    binding.equivalentMappingSnapshotHashes?.includes(pinnedHash) === true
  );
}
