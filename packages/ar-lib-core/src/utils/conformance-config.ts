/**
 * Conformance Mode Configuration Manager
 *
 * Hybrid approach for managing conformance mode:
 * - Environment variables provide defaults (requires deploy to change)
 * - KV storage provides dynamic overrides (changes without deploy)
 *
 * Priority: KV > Environment variable > Default value
 *
 * Conformance Mode Behavior:
 * - enabled = true  → Use built-in HTML forms (for OIDC conformance testing)
 * - enabled = false → Redirect to external UI (production mode)
 * - enabled = false + UI_URL not set → Return 500 configuration error
 */

import type { Env } from '../types/env';
import {
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from '../services/effective-settings';

/**
 * Conformance mode configuration
 */
export interface ConformanceConfig {
  /** Enable conformance mode (use built-in forms instead of external UI) */
  enabled: boolean;
  /** Use built-in HTML forms when conformance mode is enabled */
  useBuiltinForms: boolean;
}

/**
 * Default conformance configuration
 * Default: disabled for security (production mode)
 */
export const DEFAULT_CONFORMANCE_CONFIG: ConformanceConfig = {
  enabled: false,
  useBuiltinForms: true, // When conformance is enabled, use built-in forms
};

/**
 * Used when the saved settings cannot be read: conformance mode opens test-only paths, so an
 * unreadable setting must not fall back to a value (env) that enables it.
 */
const CONFORMANCE_UNAVAILABLE: ConformanceConfig = Object.freeze({
  enabled: false,
  useBuiltinForms: false,
});

/**
 * Get conformance mode configuration: `feature.conformance_enabled` and
 * `feature.conformance_use_builtin_forms` for the platform, as the Settings API resolves them
 * (the platform's values, else ENABLE_CONFORMANCE_MODE, else off). Disabled when they cannot be read: conformance mode opens
 * test-only paths, so an unreadable setting must not fall back to a value that enables it.
 *
 * @param env Environment bindings
 * @returns Conformance configuration
 */
export async function getConformanceConfig(
  env: Partial<Pick<Env, 'SETTINGS' | 'AUTHRIM_CONFIG' | 'ENABLE_CONFORMANCE_MODE'>>
): Promise<ConformanceConfig> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(
      env as EffectiveSettingsEnv,
      'feature-flags',
      {}
    );
    return {
      enabled: values['feature.conformance_enabled'] === true,
      useBuiltinForms: values['feature.conformance_use_builtin_forms'] === true,
    };
  } catch {
    return CONFORMANCE_UNAVAILABLE;
  }
}

/**
 * Check if conformance mode is enabled
 * Convenience function for quick checks
 *
 * @param env Environment bindings
 * @returns true if conformance mode is enabled
 */
export async function isConformanceMode(
  env: Partial<Pick<Env, 'SETTINGS' | 'ENABLE_CONFORMANCE_MODE'>>
): Promise<boolean> {
  const config = await getConformanceConfig(env);
  return config.enabled;
}

/**
 * Check if built-in forms should be used
 *
 * @param env Environment bindings
 * @returns true if built-in forms should be used
 */
export async function shouldUseBuiltinForms(
  env: Partial<Pick<Env, 'SETTINGS' | 'ENABLE_CONFORMANCE_MODE'>>
): Promise<boolean> {
  const config = await getConformanceConfig(env);
  return config.enabled && config.useBuiltinForms;
}

/**
 * Conformance mode error response
 * Used when conformance mode is disabled but UI_URL is not configured
 */
export interface ConformanceConfigError {
  error: 'configuration_error';
  error_description: string;
}

/**
 * Create configuration error response
 * For use when UI_URL is not configured and conformance mode is disabled
 */
export function createConfigurationError(): ConformanceConfigError {
  return {
    error: 'configuration_error',
    error_description: 'UI_URL is not configured and conformance mode is disabled',
  };
}
