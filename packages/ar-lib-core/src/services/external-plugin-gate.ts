/**
 * Whether a tenant lets the code of external (custom, dynamic worker) plugins run.
 *
 * The switch is `plugin.enabled`: the tenant's value, else the environment variable
 * `PLUGIN_ENABLED`, else off. It never covers the built-in plugins (email providers, CAPTCHA
 * providers, TOTP): those are switched by the plugin admin API, the Email Settings order and
 * `authentication-methods.human_verification`.
 *
 * This reads the settings the runtime reads (the KV copy, which can lag a saved change by about a
 * minute or until a pending projection is retried), so it is an early check only. What stops
 * external code is the tenant gate in ar-plugin-runner (`plugin_runner_tenant_external_gates`),
 * which ar-management keeps in step with the saved setting (setTenantExternalGate) and which the
 * runner checks whenever it resolves an external installation to execute.
 */

import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

/** The error code of an enable that the gate refused. */
export const EXTERNAL_PLUGIN_EXECUTION_NOT_ALLOWED = 'external_plugin_execution_not_allowed';

export type ExternalPluginExecutionState = 'allowed' | 'denied' | 'unreadable';

/**
 * Whether the tenant allows external plugin code: 'allowed' only for an explicit on, 'denied' when
 * the settings were read and it is not on, 'unreadable' when they could not be read (a stored
 * document that fails to load, a malformed tenant id, a KV error). Callers that hold work back
 * (rather than refuse it) retry on 'unreadable'; none may treat it as 'allowed'. Nothing from the
 * settings is logged.
 *
 * Runtime reads use the short per-isolate cache; `fresh` skips it, for admin actions that must see
 * a value just saved.
 */
export async function getExternalPluginExecutionState(
  env: EffectiveSettingsEnv & { PLUGIN_ENABLED?: string },
  tenantId: string,
  options: { fresh?: boolean } = {}
): Promise<ExternalPluginExecutionState> {
  try {
    const values = await resolveEffectiveSettings(env, 'plugin', {
      tenantId,
      ...(options.fresh ? { fresh: true } : {}),
    });
    return values['plugin.enabled'] === true ? 'allowed' : 'denied';
  } catch {
    return 'unreadable';
  }
}

/** True only for 'allowed': an unreadable setting is not permission (fail-closed). */
export async function isExternalPluginExecutionAllowed(
  env: EffectiveSettingsEnv & { PLUGIN_ENABLED?: string },
  tenantId: string,
  options: { fresh?: boolean } = {}
): Promise<boolean> {
  return (await getExternalPluginExecutionState(env, tenantId, options)) === 'allowed';
}
