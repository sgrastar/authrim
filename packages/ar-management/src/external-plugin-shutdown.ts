/**
 * Switches off the external (dynamic worker) plugin installations of a tenant that no longer
 * allows external plugin code (`plugin.enabled` turned off).
 *
 * This is the housekeeping half of turning the setting off. What stops external code is the
 * tenant gate in ar-plugin-runner, which the caller closes first (external-plugin-gate-sync.ts):
 * with the gate closed no installation is resolved for execution, queued hooks included. Switching
 * the installations off as well keeps their state in line (a plugin should not come back by itself
 * when the setting is turned on again) and cancels a delayed activation.
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  configureDynamicPluginWithControl,
  getDynamicPluginResourcePreparationForDisable,
} from './plugin-dynamic-worker-control';
import { cancelDynamicPluginResourceFinalization } from './plugin-resource-finalization';

const SETTING_KEY = 'plugin.enabled';

/** The part of a settings PATCH this module reads. */
export interface PluginSettingsPatch {
  set?: Record<string, unknown>;
}

/** What `SettingsManager.patch(..., { dryRun: true })` decided. */
export interface PatchDecision {
  applied: readonly string[];
  cleared: readonly string[];
  disabled: readonly string[];
}

/**
 * True when the PATCH, as the settings manager would accept it (the dry-run decision, so a
 * refused or conflicting request never counts), leaves `plugin.enabled` off: it sets false,
 * disables the key, or clears the tenant's value while what it would inherit (the environment
 * variable, else the default) is not true. `inheritedValue` is only asked for in the clear case.
 */
export async function patchTurnsExternalPluginsOff(
  patch: PluginSettingsPatch,
  decision: PatchDecision,
  inheritedValue: () => Promise<unknown>
): Promise<boolean> {
  if (decision.disabled.includes(SETTING_KEY)) return true;
  if (decision.applied.includes(SETTING_KEY) && patch.set?.[SETTING_KEY] === false) return true;
  if (decision.cleared.includes(SETTING_KEY)) return (await inheritedValue()) !== true;
  return false;
}

/** A shutdown that stopped some plugins before failing: the audit needs to know which. */
export class ExternalPluginShutdownError extends Error {
  constructor(
    readonly stopped: readonly string[],
    readonly failedPluginId: string | null
  ) {
    super('external_plugin_shutdown_failed');
    this.name = 'ExternalPluginShutdownError';
  }
}

/**
 * Switches off every external plugin installation of the tenant that is enabled, or whose
 * activation is staged, and cancels the delayed activation. Built-in plugins are not touched. Any
 * failure is thrown: the caller must not report the tenant as switched off.
 *
 * Returns the ids of the plugins switched off.
 */
export async function disableTenantExternalPlugins(env: Env, tenantId: string): Promise<string[]> {
  const runner = env.PLUGIN_RUNNER;
  // Without a plugin runner no external plugin can be installed, so there is nothing to stop.
  if (!runner || typeof runner.listApprovedDynamicPlugins !== 'function') return [];
  const disabled: string[] = [];
  let current: string | null = null;
  try {
    for (const plugin of await runner.listApprovedDynamicPlugins()) {
      const pluginId = plugin.pluginId;
      current = pluginId;
      const status = await runner.getDynamicPluginInstallationStatus({ tenantId, pluginId });
      const preparation = await getDynamicPluginResourcePreparationForDisable(env, {
        tenantId,
        pluginId,
      });
      if (status.state !== 'enabled' && !preparation) continue;
      await configureDynamicPluginWithControl(env, { tenantId, pluginId, enabled: false });
      if (preparation && env.SETTINGS) {
        await cancelDynamicPluginResourceFinalization(env.SETTINGS, {
          operationId: preparation.operationId,
          tenantId,
          pluginId,
        });
      }
      disabled.push(pluginId);
      current = null;
    }
  } catch {
    throw new ExternalPluginShutdownError(disabled, current);
  }
  return disabled;
}
