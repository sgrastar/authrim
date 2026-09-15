import type { DatabaseTenantBundleReferenceIndex } from './validation-index';

/**
 * Resolve one sealed reference page across the complete input set. The caller persists cursor and
 * counters together only after success, and publishes validation completion only after all datasets
 * and pages pass. A provenance-only historical admin actor is the sole missing-target exception.
 */
export async function validateTenantBackupReferencePage(input: {
  index: Pick<DatabaseTenantBundleReferenceIndex, 'referencesPage' | 'hasRecord'>;
  after: string;
  assertCompleteInputInspection: () => Promise<void>;
}): Promise<{ nextCursor: string; done: boolean; examined: number; unresolvedProvenance: number }> {
  await input.assertCompleteInputInspection();
  const page = await input.index.referencesPage(input.after);
  let unresolvedProvenance = 0;
  for (const { bundleId, dependency } of page.entries) {
    if (!(await input.index.hasRecord(dependency.from, bundleId)))
      throw new Error('backup_reference_source_missing');
    if (await input.index.hasRecord(dependency.to)) continue;
    if (dependency.to.requirement === 'provenance' && dependency.to.meaning === 'admin_actor')
      unresolvedProvenance++;
    else throw new Error('backup_reference_target_missing');
  }
  await input.assertCompleteInputInspection();
  return {
    nextCursor: page.nextCursor,
    done: page.done,
    examined: page.entries.length,
    unresolvedProvenance,
  };
}
