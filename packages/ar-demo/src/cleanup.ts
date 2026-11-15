import {
  AdminApiError,
  TENANT_DESCRIPTION,
  tenantDisplayName,
  cleanupProvisioning,
  deleteTenant,
  getTenantLifecycle,
  retryProvisioning,
} from './admin-api';
import type { Config } from './config';
import { loadConfig } from './config';
import { logError, logEvent } from './log';
import * as registry from './registry';
import type { Deps, Env, RegistryRow } from './types';

/** The lifecycle states an operator may delete from (a deletion job that failed leaves `suspended`). */
const DELETABLE_LIFECYCLES = new Set(['active', 'suspended', 'frozen', 'migration_read_only']);

type Outcome = 'gone' | 'foreign' | 'requested' | 'pending' | 'error' | 'config';

export interface CleanupSummary {
  claimed: number;
  deleted: number;
  foreign: number;
  deleting: number;
  errors: number;
  stuck: number;
  purged: number;
  stopped: boolean;
}

function isConfigError(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    (error.kind === 'config' || error.status === 401 || error.status === 403)
  );
}

/**
 * One step towards the tenant being gone. "Gone" is only ever a 404 for the tenant (or a
 * tombstone whose lifecycle is `deleted`): every other answer, error or odd state leaves the row
 * in `deleting`, so capacity is never released for a tenant that may still exist.
 *
 * Upstream calls per row: the lookup, then either the DELETE or (provisioning) the cleanup and at
 * most one retry: at most 3. A run handles at most 10 rows in each of two phases, so at most 60
 * calls, plus the token requests (their number depends on the token lifetime).
 */
async function advance(config: Config, deps: Deps, row: RegistryRow): Promise<Outcome> {
  try {
    const tenant = await getTenantLifecycle(config, deps, row.id);
    if (tenant.kind === 'absent' || tenant.lifecycle === 'deleted') return 'gone';
    // A registry row alone never authorises a write. An unconfirmed row (the core never accepted
    // the creation: queued, in flight or lost) never reached the invitation step, so no visitor administered that tenant, and
    // nobody else could have set this exact name and description on a colliding id by accident.
    if (
      row.create_accepted_at === null &&
      (tenant.name !== tenantDisplayName(row.id) || tenant.description !== TENANT_DESCRIPTION)
    ) {
      return 'foreign';
    }
    if (tenant.lifecycle === 'provisioning') {
      // Never finished: the provisioning cleanup removes the draft and leaves a `deleted` row.
      const cleaned = await cleanupProvisioning(config, deps, row.id);
      if (cleaned.kind === 'cleaned') return 'gone';
      // The core refuses the cleanup for good once activation has begun, but a provisioning that
      // is blocked there can be retried: it then completes, the tenant becomes active, and a later
      // run deletes it. Retrying is issued only for a blocked operation (the retry refuses others).
      if (
        cleaned.kind === 'conflict' &&
        cleaned.status === 'blocked' &&
        (cleaned.currentStep === 'lookup_activate' || cleaned.currentStep === 'tenant_active')
      ) {
        await retryProvisioning(config, deps, row.id);
      }
      return 'pending';
    }
    if (DELETABLE_LIFECYCLES.has(tenant.lifecycle)) {
      const result = await deleteTenant(config, deps, row.id);
      if (result === 'accepted') return 'requested';
      if (result === 'absent') return 'gone';
      return 'pending';
    }
    return 'pending'; // deleting, restoring, anything unknown
  } catch (error) {
    if (isConfigError(error)) {
      logError('cleanup_config_error', {
        tenantId: row.id,
        ...(error instanceof AdminApiError && error.status !== undefined
          ? { status: error.status }
          : {}),
        error: error instanceof AdminApiError ? (error.code ?? error.kind) : 'unexpected',
      });
      return 'config';
    }
    logError('cleanup_upstream_failure', {
      tenantId: row.id,
      ...(error instanceof AdminApiError && error.status !== undefined
        ? { status: error.status }
        : {}),
      error: error instanceof AdminApiError ? (error.code ?? error.kind) : 'unexpected',
    });
    return 'error';
  }
}

export async function runCleanup(env: Env, deps: Deps, config: Config): Promise<CleanupSummary> {
  const clock = (): number => Math.floor(deps.now() / 1000);
  const summary: CleanupSummary = {
    claimed: 0,
    deleted: 0,
    foreign: 0,
    deleting: 0,
    errors: 0,
    stuck: 0,
    purged: 0,
    stopped: false,
  };

  const settle = async (row: RegistryRow, outcome: Outcome): Promise<void> => {
    if (outcome === 'gone') {
      if (await registry.markDeleted(env.DB, row.id, clock())) summary.deleted += 1;
      logEvent('tenant_deleted', { tenantId: row.id });
    } else if (outcome === 'foreign') {
      // Never the portal's tenant: no write was made; the row is released.
      logError('cleanup_not_ours', { tenantId: row.id });
      if (await registry.markDeleted(env.DB, row.id, clock())) summary.foreign += 1;
    } else if (outcome === 'requested') {
      await registry.recordDeleteRequested(env.DB, row.id, clock());
      summary.deleting += 1;
    } else if (outcome === 'pending') {
      summary.deleting += 1;
    } else {
      summary.errors += 1;
    }
  };

  // Phase 1: claim and start deleting.
  for (const row of await registry.selectCandidates(env.DB, clock())) {
    if (!(await registry.claimForDeletion(env.DB, row.id, row.state, clock()))) continue;
    summary.claimed += 1;
    const outcome = await advance(config, deps, row);
    await settle(row, outcome);
    if (outcome === 'config') {
      summary.stopped = true;
      break;
    }
  }

  // Phase 2: ask about rows that are still deleting (and retry the ones whose job failed).
  if (!summary.stopped) {
    for (const row of await registry.selectProbeRows(env.DB, clock())) {
      if (!(await registry.claimProbe(env.DB, row.id, clock()))) continue;
      const outcome = await advance(config, deps, row);
      await settle(row, outcome);
      if (outcome === 'config') {
        summary.stopped = true;
        break;
      }
    }
  }

  const endedAt = clock();
  summary.stuck = await registry.countStuck(env.DB, endedAt);
  if (summary.stuck > 0) logError('cleanup_stuck', { count: summary.stuck });
  summary.purged = await registry.purgeDeleted(env.DB, endedAt);

  logEvent('cleanup_run', {
    claimed: summary.claimed,
    deleted: summary.deleted,
    foreign: summary.foreign,
    deleting: summary.deleting,
    errors: summary.errors,
  });
  return summary;
}

/** The scheduled entry point: never throws. */
export async function handleScheduled(env: Env, deps: Deps): Promise<CleanupSummary | null> {
  try {
    const loaded = loadConfig(env);
    if (!loaded.ok) {
      logError('config_invalid', { detail: loaded.problems.join(',') });
      return null;
    }
    return await runCleanup(env, deps, loaded.config);
  } catch {
    logError('cleanup_unhandled_error');
    return null;
  }
}
