/**
 * Keeps ar-plugin-runner's tenant gate for external plugin code in step with the saved
 * `plugin.enabled`.
 *
 * The runner cannot read tenant settings and refuses to resolve any external (dynamic worker)
 * installation of a tenant whose gate is not open, so that gate, not this module and not the
 * settings KV, is what stops external code. This module only decides what to put in it:
 *
 * - the value comes from the canonical settings document (D1), never from the KV copy, which can
 *   lag a saved change (projection pending) and so can still say "on" after the tenant turned it
 *   off. Without the admin database no document is saved anywhere but KV, and KV is read;
 * - closing is always safe, unconditional and goes first; opening only follows a saved "on", and
 *   is a compare-and-swap on the gate's generation (see reconcileRunnerExternalGate), so an open
 *   decided before a turn-off cannot land after it;
 * - a gate that cannot be written stays as it was: closed unless it was opened before.
 *
 * What remains, by design (no lease or fence is kept across the services): work already launched
 * when the gate closes completes; the generation check closes the window between reading the
 * setting and opening, not the milliseconds between a successful runner check and the launch; and
 * a turn-off whose gate write failed was refused, so the gate it left is the one it found.
 */

import {
  ALL_CATEGORY_META,
  createSettingsManager,
  requireDedicatedAdminDatabaseAdapter,
  settingsParentScopes,
  type Env,
  type SettingScope,
  type TenantExternalGate,
} from '@authrim/ar-lib-core';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';

/** The gate (or the saved setting) cannot be read or written right now. */
export class ExternalPluginGateUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('external_plugin_gate_unavailable');
    this.name = 'ExternalPluginGateUnavailableError';
  }
}

/**
 * The tenant's saved `plugin.enabled` as the settings API holds it: the canonical document, else
 * the environment variable, else off. Throws ExternalPluginGateUnavailableError when it cannot be
 * read (an unreadable setting is never "on").
 */
export async function readSavedExternalPluginSetting(env: Env, tenantId: string): Promise<boolean> {
  try {
    const manager = createSettingsManager({
      env: env as unknown as Record<string, string | undefined>,
      kv: env.SETTINGS ?? null,
      legacyKv: env.AUTHRIM_CONFIG ?? null,
      canonicalStore: env.DB_ADMIN
        ? new DatabaseSettingsCanonicalStore(
            requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
          )
        : null,
      strictReads: true,
      readOnly: true,
      cacheTTL: 0,
    });
    manager.registerCategory(ALL_CATEGORY_META.plugin);
    const scope: SettingScope = { type: 'tenant', id: tenantId };
    const result = await manager.getAll('plugin', scope, {
      parents: settingsParentScopes('plugin', scope),
    });
    return result.values['plugin.enabled'] === true;
  } catch {
    throw new ExternalPluginGateUnavailableError('saved_setting_unreadable');
  }
}

const GATE_CONFLICT = 'plugin_dynamic_external_gate_generation_conflict';
const RECONCILE_ATTEMPTS = 3;

/** The runner refused an open decided on a generation that has moved on (a close came between). */
export class ExternalPluginGateConflictError extends ExternalPluginGateUnavailableError {
  constructor() {
    super('gate_generation_conflict');
    this.name = 'ExternalPluginGateConflictError';
  }
}

function gateService(env: Env, options: { requireRunner?: boolean }) {
  const runner = env.PLUGIN_RUNNER;
  if (!runner) {
    if (options.requireRunner) throw new ExternalPluginGateUnavailableError('runner_unavailable');
    return null;
  }
  // A runner that cannot take the gate cannot enforce it: neither opening nor closing may pass.
  if (
    typeof runner.setTenantExternalGate !== 'function' ||
    typeof runner.getTenantExternalGate !== 'function'
  ) {
    throw new ExternalPluginGateUnavailableError('runner_gate_unsupported');
  }
  return runner;
}

/** The runner's gate for the tenant, or null when there is no plugin runner (unless required). */
export async function getRunnerExternalGate(
  env: Env,
  tenantId: string,
  options: { requireRunner?: boolean } = {}
): Promise<TenantExternalGate | null> {
  const runner = gateService(env, options);
  if (!runner) return null;
  try {
    const gate = await runner.getTenantExternalGate({ tenantId });
    if (gate.tenantId !== tenantId) throw new Error('mismatch');
    return gate;
  } catch {
    throw new ExternalPluginGateUnavailableError('gate_read_failed');
  }
}

/**
 * Closes the tenant's gate in the plugin runner, whatever its state (every close advances its
 * generation, which is what invalidates an open decided earlier), or opens it if its generation
 * still is `ifGeneration` (the one read before the saved setting was read). Returns null when
 * there is no plugin runner, unless `requireRunner` is set. Throws ExternalPluginGateUnavailableError
 * when the runner cannot be reached, and its subclass ExternalPluginGateConflictError when a
 * stale open is refused.
 */
export async function setRunnerExternalGate(
  env: Env,
  tenantId: string,
  allowed: boolean,
  options: { requireRunner?: boolean; ifGeneration?: number } = {}
): Promise<TenantExternalGate | null> {
  const runner = gateService(env, options);
  if (!runner) return null;
  if (allowed && options.ifGeneration === undefined) {
    throw new ExternalPluginGateUnavailableError('open_without_generation');
  }
  try {
    const gate = await runner.setTenantExternalGate({
      tenantId,
      allowed,
      ...(allowed ? { ifGeneration: options.ifGeneration } : {}),
    });
    if (gate.tenantId !== tenantId || gate.allowed !== allowed) {
      throw new Error('mismatch');
    }
    return gate;
  } catch (error) {
    if (error instanceof Error && error.message === GATE_CONFLICT) {
      throw new ExternalPluginGateConflictError();
    }
    throw new ExternalPluginGateUnavailableError('gate_write_failed');
  }
}

export type GateReconcileAction = 'opened' | 'closed' | 'unchanged';

/**
 * Puts the runner's gate where the saved setting says it should be and returns that value and
 * what was done. The order is what makes it safe against a turn-off that completes in between:
 * (a) read the gate's generation, (b) read the saved setting, (c) open only if the generation is
 * still the one read in (a). A turn-off closes the gate (advancing it) before it saves, and
 * closes it again after, so an open decided on a "true" read before the save cannot land after
 * it. A refused open is decided again from the start (a few times), then reported as unavailable.
 *
 * `sweep` is the periodic reconciliation: a gate that is closed already is not written again
 * (a missing row is a closed gate; writing one changes nothing), and a tenant whose setting
 * already matches the gate state `observed` in the candidate listing costs no runner call.
 *
 * Used after a save, before an external plugin is switched on, when the account event snapshot
 * finds an allowed tenant with a closed gate, and by the sweep.
 */
export async function reconcileRunnerExternalGateDetailed(
  env: Env,
  tenantId: string,
  options: {
    requireRunner?: boolean;
    sweep?: boolean;
    observed?: { allowed: boolean };
  } = {}
): Promise<{ saved: boolean; action: GateReconcileAction }> {
  if (options.sweep && options.observed) {
    const saved = await readSavedExternalPluginSetting(env, tenantId);
    if (saved === options.observed.allowed) return { saved, action: 'unchanged' };
  }
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
    const gate = await getRunnerExternalGate(env, tenantId, options);
    const saved = await readSavedExternalPluginSetting(env, tenantId);
    if (!saved) {
      if (options.sweep && gate && !gate.allowed) return { saved, action: 'unchanged' };
      await setRunnerExternalGate(env, tenantId, false, options);
      return { saved, action: gate?.allowed ? 'closed' : 'unchanged' };
    }
    if (gate === null || gate.allowed) return { saved, action: 'unchanged' };
    try {
      await setRunnerExternalGate(env, tenantId, true, {
        ...options,
        ifGeneration: gate.generation,
      });
      return { saved, action: 'opened' };
    } catch (error) {
      if (!(error instanceof ExternalPluginGateConflictError)) throw error;
    }
  }
  throw new ExternalPluginGateUnavailableError('gate_generation_conflict');
}

/** The saved setting's value, with the gate put in step (see reconcileRunnerExternalGateDetailed). */
export async function reconcileRunnerExternalGate(
  env: Env,
  tenantId: string,
  options: { requireRunner?: boolean } = {}
): Promise<boolean> {
  return (await reconcileRunnerExternalGateDetailed(env, tenantId, options)).saved;
}
