/**
 * The periodic reconciliation of ar-plugin-runner's gates for external plugin code.
 *
 * The gate is a projection of `plugin.enabled`, written when the setting is saved or an external
 * plugin is enabled. Writes fail, an environment variable (PLUGIN_ENABLED) changes without a
 * save, and a gate that was never written (the migration that added it, a restore) means closed.
 * Each scheduled run takes the next page of the tenants the runner lists as possibly drifted
 * (listTenantExternalGateCandidates: every open gate, and every tenant with an enabled external
 * installation but no open gate), compares each with its saved setting and, where they differ,
 * opens or closes the gate (compare-and-swap, see external-plugin-gate-sync.ts). A rolling cursor
 * (a KV key, best effort: a lost cursor only repeats a page) carries the pass over runs, so every
 * tenant is looked at once per pass: a drift lasts until its tenant's turn, at most
 * ceil(candidates / SWEEP_LIMIT) runs (the directory cron runs every two minutes).
 *
 * A tenant whose setting is off and whose gate is closed already is left alone, even with an
 * enabled external installation behind it (a closed gate is the safe state; the installation
 * switches off when the tenant next saves, and a missing gate row means the same as a closed one).
 * It stays in the listing, which costs one settings read per pass.
 */

import type { Env } from '@authrim/ar-lib-core';
import { reconcileRunnerExternalGateDetailed } from './external-plugin-gate-sync';

/** Tenants reconciled per scheduled run. */
export const SWEEP_LIMIT = 50;
const CURSOR_KEY = 'plugins:external-gate-sweep:cursor';

export interface GateSweepLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface GateSweepResult {
  examined: number;
  opened: number;
  closed: number;
  failed: number;
}

/** One page of the reconciliation. Returns null when there is no plugin runner to reconcile. */
export async function sweepExternalPluginGates(
  env: Env,
  log: GateSweepLogger,
  options: { limit?: number } = {}
): Promise<GateSweepResult | null> {
  const runner = env.PLUGIN_RUNNER;
  if (!runner || typeof runner.listTenantExternalGateCandidates !== 'function') return null;
  const limit = Math.max(1, Math.min(SWEEP_LIMIT, options.limit ?? SWEEP_LIMIT));
  let after: string | null = null;
  try {
    after = (await env.SETTINGS?.get(CURSOR_KEY)) ?? null;
  } catch {
    after = null;
  }
  const candidates = await runner.listTenantExternalGateCandidates({ limit, after });
  const result: GateSweepResult = { examined: 0, opened: 0, closed: 0, failed: 0 };
  for (const candidate of candidates) {
    result.examined += 1;
    try {
      const { action } = await reconcileRunnerExternalGateDetailed(env, candidate.tenantId, {
        requireRunner: true,
        sweep: true,
        observed: candidate,
      });
      if (action === 'opened') result.opened += 1;
      if (action === 'closed') result.closed += 1;
    } catch {
      // Only the fact is logged (no setting values); the tenant is looked at again next pass.
      result.failed += 1;
    }
  }
  try {
    const last = candidates.at(-1);
    if (last && candidates.length >= limit) await env.SETTINGS?.put(CURSOR_KEY, last.tenantId);
    else await env.SETTINGS?.delete(CURSOR_KEY);
  } catch {
    // A cursor that was not kept repeats a page, which is harmless.
  }
  if (result.opened > 0 || result.closed > 0) {
    log.info('External plugin gates reconciled with plugin.enabled', { ...result });
  }
  if (result.failed > 0) {
    log.warn('Some external plugin gates could not be reconciled; retried next pass', {
      failed: result.failed,
    });
  }
  return result;
}
