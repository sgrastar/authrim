/**
 * A command action timed from start to end, with its steps (see `core/phase-timings.ts`): the
 * timings are printed and saved however the command ends: when it returns, or at exit when it
 * throws or calls `process.exit`.
 */
import { startPhaseTimings } from '../core/phase-timings.js';

export function timedCommand<O extends { env?: string }, R>(
  command: string,
  action: (options: O, ...rest: unknown[]) => Promise<R>
): (options: O, ...rest: unknown[]) => Promise<R> {
  return async (options: O, ...rest: unknown[]) => {
    const { finish } = startPhaseTimings({
      command,
      env: typeof options?.env === 'string' ? options.env : null,
    });
    // A failure is reported at exit, with the code the CLI ends with (a cancelled prompt is 0).
    const result = await action(options, ...rest);
    finish(typeof process.exitCode === 'number' ? process.exitCode : 0);
    return result;
  };
}
