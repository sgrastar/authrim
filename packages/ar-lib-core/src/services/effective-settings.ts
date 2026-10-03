/**
 * Effective settings for runtime workers.
 *
 * Resolves a category the way the Settings API shows it: the client's value, else the tenant's,
 * else the platform's (where the category has those scopes), else the environment variable, else
 * the built-in default.
 */

import {
  ALL_CATEGORY_META,
  isCategoryAvailableAtScope,
  settingsParentScopes,
  type CategoryName,
} from '../types/settings/catalog';
import {
  createSettingsManager,
  type CategoryMeta,
  type SettingScope,
  type SettingSource,
  type SettingsManager,
} from '../utils/settings-manager';

export interface EffectiveSettingsEnv {
  SETTINGS?: KVNamespace;
}

export interface EffectiveSettingsTarget {
  tenantId: string;
  /** The client, for categories that can be set per client. */
  clientId?: string;
  /**
   * Read the settings documents without the per-isolate cache, for admin responses that must
   * show a value just saved.
   */
  fresh?: boolean;
}

const RUNTIME_CACHE_TTL_MS = 60_000;
/** What a scope id may look like inside a settings key (see settings-manager). */
const SETTINGS_KEY_PART = /^[a-zA-Z0-9_-]{1,128}$/;
const managers = new WeakMap<object, SettingsManager>();
const freshManagers = new WeakMap<object, SettingsManager>();

/** The manager for runtime reads (documents cached briefly), or for admin views (`fresh`). */
function managerFor(env: EffectiveSettingsEnv, fresh = false): SettingsManager {
  const key = (env.SETTINGS ?? env) as object;
  const cache = fresh ? freshManagers : managers;
  let manager = cache.get(key);
  if (!manager) {
    manager = createSettingsManager({
      env: env as unknown as Record<string, string | undefined>,
      kv: env.SETTINGS ?? null,
      cacheTTL: fresh ? 0 : RUNTIME_CACHE_TTL_MS,
      // A settings document that exists but cannot be read must not silently become defaults.
      strictReads: true,
    });
    for (const meta of Object.values(ALL_CATEGORY_META)) {
      manager.registerCategory(meta as CategoryMeta);
    }
    cache.set(key, manager);
  }
  return manager;
}

/** The effective values of one category for a tenant, or for one of its clients. */
export async function resolveEffectiveSettings(
  env: EffectiveSettingsEnv,
  category: CategoryName,
  target: EffectiveSettingsTarget
): Promise<Record<string, unknown>> {
  return (await resolveEffectiveSettingsWithSources(env, category, target)).values;
}

/** Like resolveEffectiveSettings, with where each value came from ('default' when unset). */
export async function resolveEffectiveSettingsWithSources(
  env: EffectiveSettingsEnv,
  category: CategoryName,
  target: EffectiveSettingsTarget
): Promise<{ values: Record<string, unknown>; sources: Record<string, SettingSource> }> {
  // Client settings are stored under the client id, so an id that cannot be part of a settings
  // key (such as a URL-shaped JWT bearer issuer) has none: use the tenant's.
  const clientId =
    target.clientId && SETTINGS_KEY_PART.test(target.clientId) ? target.clientId : undefined;
  const scope: SettingScope =
    clientId && isCategoryAvailableAtScope(category, 'client')
      ? { type: 'client', id: clientId, tenantId: target.tenantId }
      : { type: 'tenant', id: target.tenantId };
  const { values, sources } = await managerFor(env, target.fresh === true).getAll(category, scope, {
    parents: settingsParentScopes(category, scope),
  });
  return { values, sources };
}

/**
 * The effective values of one category for the whole platform (for settings that only the
 * platform can set): the platform's value, else the environment variable, else the built-in
 * default; with where each value came from.
 */
export async function resolvePlatformSettingsWithSources(
  env: EffectiveSettingsEnv,
  category: CategoryName,
  options: Pick<EffectiveSettingsTarget, 'fresh'> = {}
): Promise<{ values: Record<string, unknown>; sources: Record<string, SettingSource> }> {
  const { values, sources } = await managerFor(env, options.fresh === true).getAll(category, {
    type: 'platform',
  });
  return { values, sources };
}
