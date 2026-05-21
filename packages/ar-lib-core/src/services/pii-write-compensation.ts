import type { PIIStatus } from '../db/adapter';

export interface PIIStatusWriter {
  updatePIIStatus(userId: string, status: PIIStatus): Promise<boolean>;
}

export type PIIWriteCompensationResult<T> =
  | { status: 'not_required'; value?: T }
  | { status: 'active'; value: T };

export async function runPIIWriteWithCompensation<T>(options: {
  userId: string;
  userCore: PIIStatusWriter;
  requiresPIIWrite: boolean;
  write: () => Promise<T>;
}): Promise<PIIWriteCompensationResult<T>> {
  if (!options.requiresPIIWrite) {
    const value = await options.write();
    return { status: 'not_required', value };
  }

  await options.userCore.updatePIIStatus(options.userId, 'pending');

  try {
    const value = await options.write();
    await options.userCore.updatePIIStatus(options.userId, 'active');
    return { status: 'active', value };
  } catch (error) {
    await options.userCore.updatePIIStatus(options.userId, 'failed').catch(() => {});
    throw error;
  }
}
