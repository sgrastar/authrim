import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { Phase4ExternalPrerequisite } from '@authrim/ar-lib-core/services/tenant-portability/phase4-external-prerequisites';
import {
  collectBundlePlatformProfileIds,
  findUnusablePlatformProfiles,
  PLATFORM_PROFILE_FLOW_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/platform-profile-prerequisites';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { TenantBackupValidatedInputPorts } from './tenant-backup-validated-input-port';

/**
 * Restore preview warnings for platform profiles the bundle's Flows name which the target
 * environment lacks or is deleting. The bundle side is read from the validated input under the
 * sealed restore plan (the same reader the restore itself uses), the target side from the admin
 * database. Computed at preview and again at approval, so it is a pure read of both.
 */
export async function loadBundlePlatformProfileWarnings(input: {
  validatedInput: Pick<
    TenantBackupValidatedInputPorts,
    'isDatasetSelected' | 'loadValidatedDatasetById'
  >;
  admin: Pick<DatabaseAdapter, 'queryOne'>;
  context: TenantBackupStepContext;
  planDigest: string;
}): Promise<Phase4ExternalPrerequisite[]> {
  const { validatedInput, context, planDigest } = input;
  // A bundle without Flows (settings not selected) names no profile.
  if (!(await validatedInput.isDatasetSelected(context, planDigest, PLATFORM_PROFILE_FLOW_DATASET)))
    return [];
  async function* readRows(datasetId: string): AsyncGenerator<string> {
    if (!(await validatedInput.isDatasetSelected(context, planDigest, datasetId))) return;
    const source = await validatedInput.loadValidatedDatasetById(context, planDigest, datasetId);
    let sourceCursor: string | null = null;
    for (;;) {
      context.signal.throwIfAborted();
      const next = await source.readNextValidatedRow({ sourceCursor });
      if (!next) return;
      yield next.rowJson;
      sourceCursor = next.nextCursor;
    }
  }
  const ids = await collectBundlePlatformProfileIds(readRows);
  return findUnusablePlatformProfiles(input.admin, ids);
}
