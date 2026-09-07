import type { AuthrimConfig } from './config.js';
import { cleanupSetupMachineAccessInD1, ensureSetupMachineAccessInD1 } from './cloudflare.js';
import { withEnvironmentOperationForEnvironment } from './lock.js';

interface EphemeralSetupMachineAccessInput<T> {
  env: string;
  config: AuthrimConfig;
  keysDir: string;
  databaseIdentifier?: string;
  onProgress?: (message: string) => void;
  action: () => Promise<T>;
}

async function ensureEphemeralAccess<T>(
  input: EphemeralSetupMachineAccessInput<T>,
  databaseOptions: { databaseIdentifier: string } | undefined
) {
  return databaseOptions
    ? ensureSetupMachineAccessInD1(
        input.env,
        input.config,
        input.keysDir,
        input.onProgress,
        databaseOptions
      )
    : input.onProgress
      ? ensureSetupMachineAccessInD1(input.env, input.config, input.keysDir, input.onProgress)
      : ensureSetupMachineAccessInD1(input.env, input.config, input.keysDir);
}

async function cleanupEphemeralAccess<T>(
  input: EphemeralSetupMachineAccessInput<T>,
  databaseOptions: { databaseIdentifier: string } | undefined
) {
  return databaseOptions
    ? cleanupSetupMachineAccessInD1(input.env, input.keysDir, input.onProgress, databaseOptions)
    : input.onProgress
      ? cleanupSetupMachineAccessInD1(input.env, input.keysDir, input.onProgress)
      : cleanupSetupMachineAccessInD1(input.env, input.keysDir);
}

async function cleanupEphemeralAccessSafely<T>(
  input: EphemeralSetupMachineAccessInput<T>,
  databaseOptions: { databaseIdentifier: string } | undefined
): Promise<{ success: boolean; error?: string }> {
  try {
    return await cleanupEphemeralAccess(input, databaseOptions);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'cleanup_threw_non_error',
    };
  }
}

/** Run the ephemeral credential lifecycle when the caller already owns the environment lock. */
export async function runEphemeralSetupMachineAccess<T>(
  input: EphemeralSetupMachineAccessInput<T>
): Promise<T> {
  const databaseOptions = input.databaseIdentifier
    ? { databaseIdentifier: input.databaseIdentifier }
    : undefined;
  let access: { success: boolean; error?: string };
  try {
    access = await ensureEphemeralAccess(input, databaseOptions);
  } catch (error) {
    access = {
      success: false,
      error: error instanceof Error ? error.message : 'bootstrap_threw_non_error',
    };
  }
  if (!access.success) {
    const accessError = new Error(
      `control_setup_machine_bootstrap_failed:${access.error ?? 'unknown'}`
    );
    const cleanup = await cleanupEphemeralAccessSafely(input, databaseOptions);
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

  const cleanup = await cleanupEphemeralAccessSafely(input, databaseOptions);
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

/** Backward-compatible wrapper for call sites that do not already own the environment lock. */
export async function withEphemeralSetupMachineAccess<T>(
  input: EphemeralSetupMachineAccessInput<T> & { baseDir: string }
): Promise<T> {
  return withEnvironmentOperationForEnvironment(
    {
      baseDir: input.baseDir,
      env: input.env,
      operation: 'control-capacity-machine-access',
      requireExisting: true,
    },
    async () => runEphemeralSetupMachineAccess(input)
  );
}
