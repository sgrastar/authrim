import { statfs } from 'node:fs/promises';

export const MINIMUM_PROVISIONING_FREE_BYTES = 1024 * 1024 * 1024;
export const MINIMUM_BUILD_FREE_BYTES = 1024 * 1024 * 1024;
export const MINIMUM_WORKER_DEPLOY_FREE_BYTES = 512 * 1024 * 1024;

export type LocalDeploymentPhase =
  | 'environment provisioning'
  | 'package build'
  | 'release deployment'
  | 'Worker deployment';

export type ReadAvailableDiskBytes = (path: string) => Promise<number>;

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export async function readAvailableDiskBytes(path: string): Promise<number> {
  const stats = await statfs(path, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

export class InsufficientLocalDiskSpaceError extends Error {
  readonly code = 'insufficient_local_disk_space';

  constructor(
    readonly phase: LocalDeploymentPhase,
    readonly availableBytes: number,
    readonly requiredBytes: number
  ) {
    super(
      `Insufficient local disk space for ${phase}: ${formatBytes(availableBytes)} available; ` +
        `at least ${formatBytes(requiredBytes)} is required. Free local disk space and retry. ` +
        'Setup stopped before starting the next Cloudflare mutation.'
    );
    this.name = 'InsufficientLocalDiskSpaceError';
  }
}

export async function assertLocalDeploymentCapacity(options: {
  rootDir: string;
  phase: LocalDeploymentPhase;
  minimumFreeBytes: number;
  readAvailableBytes?: ReadAvailableDiskBytes;
}): Promise<number> {
  const availableBytes = await (options.readAvailableBytes ?? readAvailableDiskBytes)(
    options.rootDir
  );
  if (!Number.isFinite(availableBytes) || availableBytes < 0) {
    throw new Error('local_disk_space_check_returned_invalid_capacity');
  }
  if (availableBytes < options.minimumFreeBytes) {
    throw new InsufficientLocalDiskSpaceError(
      options.phase,
      availableBytes,
      options.minimumFreeBytes
    );
  }
  return availableBytes;
}

export function isInsufficientLocalDiskSpaceError(
  error: unknown
): error is InsufficientLocalDiskSpaceError {
  return (
    error instanceof InsufficientLocalDiskSpaceError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'insufficient_local_disk_space')
  );
}
