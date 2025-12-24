/**
 * Storage Infrastructure Factory
 *
 * Creates storage infrastructure based on provider configuration.
 */

import type { IStorageInfra, StorageProvider, InfraEnv } from '../types';
import { CloudflareStorageInfra } from './cloudflare';

/**
 * Options for creating storage infrastructure
 */
export interface StorageInfraOptions {
  /** Storage provider (defaults to 'cloudflare') */
  provider?: StorageProvider;
}

/**
 * Create storage infrastructure instance
 *
 * @param env - Environment bindings
 * @param options - Storage options
 * @returns Initialized storage infrastructure
 *
 * @example
 * ```typescript
 * const storage = await createStorageInfra(env);
 * const user = await storage.user.get(userId);
 * ```
 */
export async function createStorageInfra(
  env: InfraEnv,
  options: StorageInfraOptions = {}
): Promise<IStorageInfra> {
  const provider = options.provider ?? (env.STORAGE_PROVIDER as StorageProvider) ?? 'cloudflare';

  let storage: IStorageInfra;

  switch (provider) {
    case 'cloudflare':
      storage = new CloudflareStorageInfra();
      break;

    case 'aws':
    case 'gcp':
    case 'azure':
      throw new Error(`Storage provider '${provider}' is not yet implemented`);

    case 'custom':
      throw new Error('Custom storage provider requires manual instantiation');

    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unknown storage provider: ${String(exhaustiveCheck)}`);
    }
  }

  await storage.initialize(env);
  return storage;
}
