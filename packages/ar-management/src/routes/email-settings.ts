import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getTenantEmailSettings,
  putTenantEmailSettings,
} from '@authrim/ar-lib-core';
import { needsBuiltinRegistration, registerBuiltinPlugins } from '@authrim/ar-lib-plugin';
import { getResolvedPluginConfigState } from './settings/plugins';

interface PluginRegistryEntry {
  id: string;
  version: string;
  capabilities: string[];
  meta?: {
    name?: string;
    description?: string;
    category?: string;
  };
}

const PLUGIN_REGISTRY_KEY = 'plugins:registry';
const EXCLUDED_EMAIL_PROVIDER_IDS = new Set(['notifier-console']);

const UpdateTenantEmailSettingsSchema = z.object({
  strategy: z.literal('priority_failover').default('priority_failover'),
  providerOrder: z.array(z.string()).default([]),
});

async function ensureBuiltinPluginsRegistered(kv: KVNamespace): Promise<void> {
  const needsRegistration = await needsBuiltinRegistration(kv);
  if (!needsRegistration) {
    return;
  }

  await registerBuiltinPlugins(kv);
}

async function getPluginRegistry(kv: KVNamespace): Promise<Record<string, PluginRegistryEntry>> {
  try {
    const data = await kv.get(PLUGIN_REGISTRY_KEY);
    if (!data) {
      return {};
    }

    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, PluginRegistryEntry>)
      : {};
  } catch {
    return {};
  }
}

function pluginIdToSettingsKey(pluginId: string): string {
  return `plugin.${pluginId.replace(/-/g, '_')}_enabled`;
}

async function isPluginEnabled(env: Env, pluginId: string, tenantId: string): Promise<boolean> {
  try {
    const configKV = env.AUTHRIM_CONFIG;
    if (configKV) {
      const settingsKey = pluginIdToSettingsKey(pluginId);
      const tenantConfig = await configKV.get(`settings:tenant:${tenantId}:plugin`);
      if (tenantConfig) {
        const parsed = JSON.parse(tenantConfig) as Record<string, unknown>;
        const enabled = parsed[settingsKey];
        if (typeof enabled === 'boolean') {
          return enabled;
        }
        if (typeof enabled === 'string') {
          return enabled === 'true';
        }
      }
    }
  } catch {
    // Fall through to legacy KV.
  }

  const kv = env.SETTINGS;
  if (!kv) {
    return true;
  }

  const tenantValue = await kv.get(`plugins:enabled:${pluginId}:tenant:${tenantId}`);
  if (tenantValue !== null) {
    return tenantValue === 'true';
  }

  const globalValue = await kv.get(`plugins:enabled:${pluginId}`);
  if (globalValue !== null) {
    return globalValue === 'true';
  }

  return true;
}

async function listEmailProviders(env: Env, tenantId: string) {
  const kv = env.SETTINGS;
  if (!kv) {
    return [];
  }

  await ensureBuiltinPluginsRegistered(kv);
  const registry = await getPluginRegistry(kv);

  const entries = Object.values(registry).filter(
    (entry) =>
      entry.capabilities.includes('notifier.email') && !EXCLUDED_EMAIL_PROVIDER_IDS.has(entry.id)
  );

  const providers = [];
  for (const entry of entries) {
    const enabled = await isPluginEnabled(env, entry.id, tenantId);
    if (!enabled) {
      continue;
    }

    const configState = await getResolvedPluginConfigState(kv, env, entry.id, tenantId);
    if (!configState.configured) {
      continue;
    }

    providers.push({
      id: entry.id,
      name: entry.meta?.name ?? entry.id,
      description: entry.meta?.description ?? '',
      category: entry.meta?.category ?? 'notification',
      configSource: configState.source,
      configured: configState.configured,
      missingRequiredFields: configState.missingRequiredFields,
      defaultFrom:
        typeof configState.config.defaultFrom === 'string'
          ? configState.config.defaultFrom
          : undefined,
    });
  }

  return providers;
}

export async function getTenantEmailSettingsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const providers = await listEmailProviders(c.env, tenantId);
  const settings = await getTenantEmailSettings(
    c.env,
    tenantId,
    providers.map((provider) => provider.id)
  );

  const providerOrder = new Map(
    settings.providerOrder.map((providerId, index) => [providerId, index])
  );
  const orderedProviders = [...providers].sort((a, b) => {
    const aIndex = providerOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = providerOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex;
  });

  return c.json({
    tenantId,
    settings,
    providers: orderedProviders,
  });
}

export async function updateTenantEmailSettingsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateTenantEmailSettingsSchema.safeParse(body);

  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const kv = c.env.SETTINGS;
  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  await ensureBuiltinPluginsRegistered(kv);
  const registry = await getPluginRegistry(kv);
  const knownProviderIds = Object.values(registry)
    .filter((entry) => entry.capabilities.includes('notifier.email'))
    .map((entry) => entry.id)
    .filter((providerId) => !EXCLUDED_EMAIL_PROVIDER_IDS.has(providerId));

  const invalidProviderId = parsed.data.providerOrder.find(
    (providerId) => !knownProviderIds.includes(providerId)
  );
  if (invalidProviderId) {
    return c.json(
      {
        error: 'invalid_provider',
        error_description: `Unknown email provider: ${invalidProviderId}`,
      },
      400
    );
  }

  const existing = await getTenantEmailSettings(c.env, tenantId);
  const preservedDisabledProviders = existing.providerOrder.filter(
    (providerId) => !parsed.data.providerOrder.includes(providerId)
  );

  const nextSettings = {
    strategy: 'priority_failover' as const,
    providerOrder: [...parsed.data.providerOrder, ...preservedDisabledProviders],
  };

  // TODO: Support round-robin and send-count based routing once the runtime
  // registry exposes strategy-aware distribution policies.
  await putTenantEmailSettings(c.env, tenantId, nextSettings);

  const providers = await listEmailProviders(c.env, tenantId);
  const settings = await getTenantEmailSettings(
    c.env,
    tenantId,
    providers.map((provider) => provider.id)
  );

  const providerOrder = new Map(
    settings.providerOrder.map((providerId, index) => [providerId, index])
  );
  const orderedProviders = [...providers].sort((a, b) => {
    const aIndex = providerOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = providerOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex;
  });

  return c.json({
    tenantId,
    settings,
    providers: orderedProviders,
  });
}
