import type { AuthrimConfig } from './config.js';
import { cleanupSetupMachineAccessInD1, ensureSetupMachineAccessInD1 } from './cloudflare.js';
import { withEnvironmentOperationForEnvironment } from './lock.js';

export async function withEphemeralSetupMachineAccess<T>(input: {
  baseDir: string;
  env: string;
  config: AuthrimConfig;
  keysDir: string;
  action: () => Promise<T>;
}): Promise<T> {
  return withEnvironmentOperationForEnvironment(
    {
      baseDir: input.baseDir,
      env: input.env,
      operation: 'control-capacity-machine-access',
      requireExisting: true,
    },
    async () => {
      const access = await ensureSetupMachineAccessInD1(input.env, input.config, input.keysDir);
      if (!access.success) {
        const accessError = new Error(
          `control_setup_machine_bootstrap_failed:${access.error ?? 'unknown'}`
        );
        const cleanup = await cleanupSetupMachineAccessInD1(input.env, input.keysDir);
        if (!cleanup.success) {
          throw new AggregateError(
            [
              accessError,
              new Error(`control_setup_machine_cleanup_failed:${cleanup.error ?? 'unknown'}`),
            ],
            'control_setup_machine_bootstrap_cleanup_failed'
          );
        }
        throw accessError;
      }

      let result: T | undefined;
      let actionError: unknown;
      try {
        result = await input.action();
      } catch (error) {
        actionError = error;
      }

      const cleanup = await cleanupSetupMachineAccessInD1(input.env, input.keysDir);
      if (!cleanup.success) {
        const cleanupError = new Error(
          `control_setup_machine_cleanup_failed:${cleanup.error ?? 'unknown'}`
        );
        if (actionError) {
          throw new AggregateError(
            [actionError, cleanupError],
            'control_capacity_machine_access_cleanup_failed'
          );
        }
        throw cleanupError;
      }
      if (actionError) {
        throw actionError instanceof Error
          ? actionError
          : new Error('control_capacity_machine_access_action_failed', { cause: actionError });
      }
      return result as T;
    }
  );
}
