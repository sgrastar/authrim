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
import { readSystemSettingsOverrides } from './system-settings-overrides';
import { parseSettingsDocument } from './tenant-settings';

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
 * Configuration metadata for Admin UI
 */
export const CONFORMANCE_CONFIG_METADATA: Record<
  keyof ConformanceConfig,
  {
    label: string;
    description: string;
    type: 'boolean';
  }
> = {
  enabled: {
    label: 'Conformance Mode',
    description:
      'Enable conformance mode for OIDC certification testing. When enabled, built-in HTML forms are used instead of external UI.',
    type: 'boolean',
  },
  useBuiltinForms: {
    label: 'Use Built-in Forms',
    description:
      'Use built-in HTML login/consent forms when conformance mode is enabled. Required for OIDC conformance testing.',
    type: 'boolean',
  },
};

/**
 * Used when the saved settings cannot be read: conformance mode opens test-only paths, so an
 * unreadable setting must not fall back to a value (older store or env) that enables it.
 */
const CONFORMANCE_UNAVAILABLE: ConformanceConfig = Object.freeze({
  enabled: false,
  useBuiltinForms: false,
});

/**
 * Get conformance mode configuration
 * Priority: Settings API platform value > KV (system_settings.conformance) >
 * env.ENABLE_CONFORMANCE_MODE > default. Disabled when the saved settings cannot be read.
 *
 * @param env Environment bindings
 * @returns Conformance configuration
 */
export async function getConformanceConfig(
  env: Partial<Pick<Env, 'SETTINGS' | 'ENABLE_CONFORMANCE_MODE'>>
): Promise<ConformanceConfig> {
  const config = await getOlderConformanceConfig(env);
  // An unreadable older document disables the mode; Settings API values must not re-enable it.
  if (config === CONFORMANCE_UNAVAILABLE) return config;
  // Values set for the platform through the Settings API (feature.conformance_*) win.
  if (!env.SETTINGS) return config;
  try {
    const overrides = await readSystemSettingsOverrides(env.SETTINGS, {
      tenantId: null,
      sections: ['conformance'],
    });
    const enabled = overrides['feature.conformance_enabled'];
    const useBuiltinForms = overrides['feature.conformance_use_builtin_forms'];
    return {
      enabled: typeof enabled === 'boolean' ? enabled : config.enabled,
      useBuiltinForms:
        typeof useBuiltinForms === 'boolean' ? useBuiltinForms : config.useBuiltinForms,
    };
  } catch {
    return CONFORMANCE_UNAVAILABLE;
  }
}

/** The configuration from the older `system_settings.conformance`, env, or the default. */
async function getOlderConformanceConfig(
  env: Partial<Pick<Env, 'SETTINGS' | 'ENABLE_CONFORMANCE_MODE'>>
): Promise<ConformanceConfig> {
  // 1. Try KV first
  if (env.SETTINGS) {
    try {
      // Throws for a stored value that is not a JSON object (empty, invalid, an array, ...).
      const parsed = parseSettingsDocument(await env.SETTINGS.get('system_settings')) as {
        conformance?: Partial<ConformanceConfig>;
      } | null;
      if (parsed) {
        if (parsed.conformance !== undefined) {
          return {
            enabled: parsed.conformance.enabled ?? DEFAULT_CONFORMANCE_CONFIG.enabled,
            useBuiltinForms:
              parsed.conformance.useBuiltinForms ?? DEFAULT_CONFORMANCE_CONFIG.useBuiltinForms,
          };
        }
      }
    } catch {
      // Not the environment variable: it could enable what the saved document disables.
      return CONFORMANCE_UNAVAILABLE;
    }
  }

  // 2. Try environment variable. Built-in forms keep their default (on): they only matter
  // while conformance mode is enabled, so this is the same as following the mode, and it stays
  // right when the Settings API turns the mode on while env has it off.
  if (env.ENABLE_CONFORMANCE_MODE !== undefined) {
    return {
      enabled: parseBoolean(env.ENABLE_CONFORMANCE_MODE),
      useBuiltinForms: DEFAULT_CONFORMANCE_CONFIG.useBuiltinForms,
    };
  }

  // 3. Return default
  return DEFAULT_CONFORMANCE_CONFIG;
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
 * Get configuration source for debugging
 *
 * @param env Environment bindings
 * @returns Source of the configuration
 */
export async function getConformanceConfigSource(
  env: Partial<Pick<Env, 'SETTINGS' | 'ENABLE_CONFORMANCE_MODE'>>
): Promise<'kv' | 'env' | 'default'> {
  // A platform value set through the Settings API is stored in KV too, and wins.
  if (env.SETTINGS) {
    try {
      const overrides = await readSystemSettingsOverrides(env.SETTINGS, {
        tenantId: null,
        sections: ['conformance'],
      });
      if (Object.keys(overrides).length > 0) return 'kv';
    } catch {
      // Fall through to the older document, as getConformanceConfig does.
    }
  }

  // Check KV first
  if (env.SETTINGS) {
    try {
      const settings = await env.SETTINGS.get('system_settings');
      if (settings) {
        const parsed = JSON.parse(settings) as { conformance?: Partial<ConformanceConfig> };
        if (parsed.conformance !== undefined) {
          return 'kv';
        }
      }
    } catch {
      // Fall through
    }
  }

  // Check environment variable
  if (env.ENABLE_CONFORMANCE_MODE !== undefined) {
    return 'env';
  }

  return 'default';
}

/**
 * Parse boolean from string
 */
function parseBoolean(value: string): boolean {
  return value.toLowerCase() === 'true' || value === '1';
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
