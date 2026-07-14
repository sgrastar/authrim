/**
 * Builtin Plugin Registry
 *
 * Utility for auto-registering builtin plugins to KV on startup.
 * This ensures Admin UI can display builtin plugins without manual registration.
 *
 * Usage:
 * ```typescript
 * import { registerBuiltinPlugins } from '@authrim/ar-lib-plugin';
 *
 * // In Worker startup
 * await registerBuiltinPlugins(env.SETTINGS);
 * ```
 */

import type { AuthrimPlugin, PluginSource, PluginTrustLevel } from './types';
import { getPluginTrustLevel } from './types';
import { zodToJSONSchema } from './schema';

// =============================================================================
// Types
// =============================================================================

/**
 * Plugin registry entry (stored in KV)
 */
export interface PluginRegistryEntry {
  id: string;
  version: string;
  capabilities: string[];
  official: boolean;
  meta?: {
    name: string;
    description: string;
    icon?: string;
    category: string;
    documentationUrl?: string;
    author?: {
      name: string;
      email?: string;
      url?: string;
    };
    license?: string;
    tags?: string[];
    stability?: 'stable' | 'beta' | 'alpha' | 'deprecated';
  };
  source: PluginSource;
  trustLevel: PluginTrustLevel;
  registeredAt: number;
}

/**
 * Registration options
 */
export interface RegisterBuiltinOptions {
  /** Force re-registration even if plugin already exists */
  force?: boolean;
  /** Logger function for diagnostics */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

// =============================================================================
// Registry Key
// =============================================================================

const PLUGINS_REGISTRY_KEY = 'plugins:registry';
const PLUGINS_SCHEMA_PREFIX = 'plugins:schema:';

function parseRegistry(data: string): Record<string, PluginRegistryEntry> {
  const parsed = JSON.parse(data) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, PluginRegistryEntry>;
}

// =============================================================================
// Builtin Plugins
// =============================================================================

// Import builtin plugins
import { builtinNotifierPlugins } from '../builtin/notifier';
import { builtinSecurityPlugins } from '../builtin/security';

/**
 * Get all builtin plugins
 */
export function getBuiltinPlugins(): AuthrimPlugin<unknown>[] {
  return [...builtinNotifierPlugins, ...builtinSecurityPlugins] as AuthrimPlugin<unknown>[];
}

/**
 * Resolve deployment-time bootstrap configuration for builtin plugins.
 *
 * These values come from setup/deploy-generated Worker environment variables
 * and should be merged before tenant/global KV overrides.
 */
export function resolveBuiltinPluginBootstrapConfig(
  env: {
    EMAIL_FROM?: string;
    EMAIL_FROM_NAME?: string;
    RESEND_API_KEY?: string;
  },
  pluginId: string
): Record<string, unknown> {
  switch (pluginId) {
    case 'notifier-cloudflare':
      return {
        ...(env.EMAIL_FROM ? { defaultFrom: env.EMAIL_FROM } : {}),
        ...(env.EMAIL_FROM_NAME ? { fromName: env.EMAIL_FROM_NAME } : {}),
      };
    case 'notifier-resend':
      if (!env.RESEND_API_KEY) {
        return {};
      }

      return {
        apiKey: env.RESEND_API_KEY,
        ...(env.EMAIL_FROM ? { defaultFrom: env.EMAIL_FROM } : {}),
      };
    default:
      return {};
  }
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register all builtin plugins to KV
 *
 * This function should be called at Worker startup to ensure
 * builtin plugins are visible in Admin UI.
 *
 * @param kv - KV namespace (SETTINGS)
 * @param options - Registration options
 * @returns Number of plugins registered
 */
export async function registerBuiltinPlugins(
  kv: KVNamespace,
  options: RegisterBuiltinOptions = {}
): Promise<{ registered: number; skipped: number; errors: string[] }> {
  const { force = false, log = () => {} } = options;
  const errors: string[] = [];
  let registered = 0;
  let skipped = 0;

  // Get existing registry
  let registry: Record<string, PluginRegistryEntry> = {};
  try {
    const data = await kv.get(PLUGINS_REGISTRY_KEY);
    if (data) {
      registry = parseRegistry(data);
    }
  } catch {
    log('Failed to parse existing registry, starting fresh');
  }

  const plugins = getBuiltinPlugins();
  log(`Registering ${plugins.length} builtin plugins`, { force });

  for (const plugin of plugins) {
    try {
      // Check if already registered (unless force)
      const existing = registry[plugin.id];
      if (existing && !force) {
        // Check if version is the same
        if (existing.version === plugin.version) {
          skipped++;
          continue;
        }
        log(`Updating plugin ${plugin.id}: ${existing.version} -> ${plugin.version}`);
      }

      // Determine source and trust level
      const source: PluginSource = {
        type: 'builtin',
        identifier: `ar-lib-plugin/builtin/${plugin.meta?.category ?? 'unknown'}/${plugin.id}`,
      };
      const trustLevel = getPluginTrustLevel(source);

      // Create registry entry
      const entry: PluginRegistryEntry = {
        id: plugin.id,
        version: plugin.version,
        capabilities: plugin.capabilities,
        official: plugin.official ?? false,
        meta: plugin.meta
          ? {
              name: plugin.meta.name,
              description: plugin.meta.description,
              icon: plugin.meta.icon,
              category: plugin.meta.category,
              documentationUrl: plugin.meta.documentationUrl,
              author: plugin.meta.author,
              license: plugin.meta.license,
              tags: plugin.meta.tags,
              stability: plugin.meta.stability,
            }
          : undefined,
        source,
        trustLevel,
        registeredAt: Date.now(),
      };

      registry[plugin.id] = entry;

      // Store schema separately
      if (plugin.configSchema) {
        try {
          const schema = zodToJSONSchema(plugin.configSchema);
          await kv.put(`${PLUGINS_SCHEMA_PREFIX}${plugin.id}`, JSON.stringify(schema));
        } catch (schemaError) {
          log(`Failed to store schema for ${plugin.id}`, {
            error: schemaError instanceof Error ? schemaError.message : String(schemaError),
          });
        }
      }

      registered++;
      log(`Registered plugin: ${plugin.id} v${plugin.version}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`${plugin.id}: ${errorMessage}`);
      log(`Failed to register plugin ${plugin.id}`, { error: errorMessage });
    }
  }

  // Save updated registry
  if (registered > 0 || force) {
    await kv.put(PLUGINS_REGISTRY_KEY, JSON.stringify(registry));
    log(`Saved registry with ${Object.keys(registry).length} plugins`);
  }

  return { registered, skipped, errors };
}

/**
 * Check if builtin plugins need registration
 *
 * Returns true if any builtin plugin is missing or outdated.
 */
export async function needsBuiltinRegistration(kv: KVNamespace): Promise<boolean> {
  try {
    const data = await kv.get(PLUGINS_REGISTRY_KEY);
    if (!data) {
      return true;
    }

    const registry = parseRegistry(data);
    const plugins = getBuiltinPlugins();

    for (const plugin of plugins) {
      const existing = registry[plugin.id];
      if (!existing || existing.version !== plugin.version) {
        return true;
      }
    }

    return false;
  } catch {
    return true;
  }
}
