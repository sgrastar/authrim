import { handleScheduled } from './cleanup';
import { logError } from './log';
import { handleSweep } from './sweep';
import type { Deps, Env } from './types';

export const CLEANUP_CRON = '*/10 * * * *';
export const SWEEP_CRON = '17 */6 * * *';

export async function dispatchScheduled(cron: string, env: Env, deps: Deps): Promise<void> {
  if (cron === CLEANUP_CRON) await handleScheduled(env, deps);
  else if (cron === SWEEP_CRON) await handleSweep(env, deps);
  else logError('scheduled_unknown_cron');
}
