import { recoverAbsentQueueCreate } from '../../core/queue-create-recovery.js';
import { withEnvironmentOperationForEnvironment } from '../../core/lock.js';
import { findAuthrimBaseDir } from '../../core/paths.js';

export async function recoverAbsentQueueCommand(options: {
  env: string;
  binding: string;
}): Promise<void> {
  const baseDir = findAuthrimBaseDir(process.cwd());
  const recovered = await withEnvironmentOperationForEnvironment(
    {
      baseDir,
      env: options.env,
      operation: 'recover-absent-queue',
    },
    () =>
      recoverAbsentQueueCreate({
        baseDir,
        environment: options.env,
        binding: options.binding,
      })
  );
  console.log(`Verified ${recovered.name} is absent from the pinned Cloudflare account.`);
  console.log(`Resume provisioning for environment ${options.env}.`);
}
