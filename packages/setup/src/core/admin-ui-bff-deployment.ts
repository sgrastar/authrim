import { existsSync } from 'node:fs';
import type { AuthrimConfig } from './config.js';
import { ensureSupplementalKeyFiles } from './keys.js';
import { ensureAdminUiBffMachineAccessInD1 } from './cloudflare.js';
import {
  loadAdminUiBffWorkerSecrets,
  type AdminUiBffWorkerSecrets,
} from './admin-machine-access.js';

/**
 * Prepare the Admin UI BFF as one fail-closed operation.
 *
 * The private key must never be deployed before its public credential has
 * been registered in DB_ADMIN, otherwise the newly deployed BFF cannot obtain
 * an Admin Machine Access token.
 */
export async function prepareAdminUiBffDeployment(options: {
  env: string;
  config: AuthrimConfig;
  keysDir: string;
  databaseIdentifier?: string;
  onProgress?: (message: string) => void;
}): Promise<AdminUiBffWorkerSecrets> {
  if (!existsSync(options.keysDir)) {
    throw new Error(`Keys directory not found: ${options.keysDir}`);
  }

  await ensureSupplementalKeyFiles(options.keysDir);
  const machineAccess = options.databaseIdentifier
    ? await ensureAdminUiBffMachineAccessInD1(
        options.env,
        options.config,
        options.keysDir,
        options.onProgress,
        { databaseIdentifier: options.databaseIdentifier }
      )
    : await ensureAdminUiBffMachineAccessInD1(
        options.env,
        options.config,
        options.keysDir,
        options.onProgress
      );
  if (!machineAccess.success) {
    throw new Error(
      `Admin UI BFF machine access bootstrap failed: ${machineAccess.error || 'unknown error'}`
    );
  }

  return loadAdminUiBffWorkerSecrets(options.keysDir);
}
