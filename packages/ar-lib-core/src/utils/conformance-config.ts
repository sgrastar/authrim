/**
 * Conformance Mode Configuration Manager
 *
 * Hybrid approach for managing conformance mode:
 * - Environment variables provide defaults (requires deploy to change)
 * - KV storage provides dynamic overrides (changes without deploy)
 *
 * Priority: KV > Environment variable > Default value
 *
 * Conformance mode enables conformance-test-only behaviour (for example, certification-suite
 * clients registered without a scope get the standard scopes). It must be off in production.
 * Login, consent and logout pages always come from the external UI (UI_URL).
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
  /** Enable conformance-test-only behaviour */
  enabled: boolean;
}

/**
 * Default conformance configuration
 * Default: disabled for security (production mode)
 */
export const DEFAULT_CONFORMANCE_CONFIG: ConformanceConfig = {
  enabled: false,
};

/**
 * Used when the saved settings cannot be read: conformance mode opens test-only paths, so an
 * unreadable setting must not fall back to a value (env) that enables it.
 */
const CONFORMANCE_UNAVAILABLE: ConformanceConfig = Object.freeze({
  enabled: false,
});

/**
 * Get conformance mode configuration: `feature.conformance_enabled` for the platform, as the
 * Settings API resolves it (the platform's value, else ENABLE_CONFORMANCE_MODE, else off).
 * Disabled when it cannot be read: conformance mode opens test-only paths, so an unreadable
 * setting must not fall back to a value that enables it.
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
