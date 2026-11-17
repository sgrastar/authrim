import { AdminApiError } from './admin-api';
import { logError, logEvent } from './log';
import { deleteSweepUser, listSweepUsers, type SweepPosition, type SweepUser } from './sweep-api';
import { loadSweepConfig, type SweepConfig } from './sweep-config';
import type { Deps, Env } from './types';

export interface SweepSummary {
  dryRun: boolean;
  scanned: number;
  eligible: number;
  attempted: number;
  deleted: number;
  skipped: number;
  errors: number;
  stopped: boolean;
  limited: boolean;
}

function isAuthorizationError(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    (error.kind === 'config' || error.status === 401 || error.status === 403)
  );
}

export async function runSweep(config: SweepConfig, deps: Deps): Promise<SweepSummary> {
  const summary: SweepSummary = {
    dryRun: config.dryRun,
    scanned: 0,
    eligible: 0,
    attempted: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    stopped: false,
    limited: false,
  };
  const users = new Map<string, SweepUser>();
  const positions = new Set<string>();
  let position: SweepPosition | undefined;
  // Finish the bounded read before any DELETE: offset pages must not shift under our mutations.
  for (let page = 0; page < config.maxPages; page += 1) {
    let result: Awaited<ReturnType<typeof listSweepUsers>>;
    try {
      result = await listSweepUsers(config, deps, position);
    } catch (error) {
      summary.errors += 1;
      summary.stopped = true;
      logError(isAuthorizationError(error) ? 'sweep_config_error' : 'sweep_list_error');
      return summary;
    }
    summary.scanned += result.users.length;
    for (const user of result.users) {
      const previous = users.get(user.id);
      if (previous && previous.createdAt !== user.createdAt) {
        summary.errors += 1;
        summary.stopped = true;
        logError('sweep_list_changed');
        return summary;
      }
      users.set(user.id, user);
    }
    if (!result.next) break;
    const key = JSON.stringify(result.next);
    if (positions.has(key) || page + 1 === config.maxPages) {
      summary.stopped = true;
      summary.limited = true;
      logError('sweep_too_many');
      return summary;
    }
    positions.add(key);
    position = result.next;
  }
  const cutoff = deps.now() - config.minAgeMinutes * 60_000;
  const eligible = [...users.values()]
    .filter((user): user is SweepUser & { createdAt: number } => {
      const keep =
        config.keepUserIds.has(user.id) || user.createdAt === null || user.createdAt > cutoff;
      if (keep) summary.skipped += 1;
      return !keep;
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  summary.eligible = eligible.length;
  summary.limited = eligible.length > config.maxDeletes;
  if (config.dryRun) return summary;
  const selected = eligible.slice(0, config.maxDeletes);
  // Await each response before sending the next DELETE; never burst a batch at the API.
  for (const user of selected) {
    summary.attempted += 1;
    try {
      const outcome = await deleteSweepUser(config, deps, user.id);
      if (outcome === 'deleted') summary.deleted += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.errors += 1;
      if (isAuthorizationError(error)) {
        summary.stopped = true;
        logError('sweep_config_error');
        break;
      }
    }
  }
  return summary;
}

export async function handleSweep(env: Env, deps: Deps): Promise<SweepSummary | null> {
  const loaded = loadSweepConfig(env);
  if (!loaded.ok) {
    logError('sweep_config_error', { detail: loaded.problems.join(',') });
    return null;
  }
  if (!loaded.config) return null;
  try {
    const summary = await runSweep(loaded.config, deps);
    logEvent('sweep_run', summary);
    return summary;
  } catch {
    logError('sweep_run_error');
    return null;
  }
}
