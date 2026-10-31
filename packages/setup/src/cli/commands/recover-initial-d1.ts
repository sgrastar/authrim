import { recoverInitialControlPlaneD1Identity } from '../../core/control-plane-bootstrap.js';
import { withEnvironmentOperationForEnvironment } from '../../core/lock.js';
import { findAuthrimBaseDir } from '../../core/paths.js';

interface RecoverInitialD1Options {
  env: string;
  binding: string;
  databaseId: string;
}

export async function recoverInitialD1Command(options: RecoverInitialD1Options): Promise<void> {
  const rootDir = findAuthrimBaseDir(process.cwd());
  const recovered = await withEnvironmentOperationForEnvironment(
    {
      baseDir: rootDir,
      env: options.env,
      operation: 'recover-initial-d1',
      requireExisting: true,
    },
    () =>
      recoverInitialControlPlaneD1Identity({
        rootDir,
        env: options.env,
        binding: options.binding,
        databaseId: options.databaseId,
      })
  );
  console.log(`Verified ${recovered.name} (${recovered.id}) against Cloudflare D1 inventory.`);
  console.log(`Resume the initial deployment for environment ${options.env}.`);
}
